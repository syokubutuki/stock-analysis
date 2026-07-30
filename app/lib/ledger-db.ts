// 前向き検証台帳のサーバ保存層（Postgres）。
//
// なぜサーバに置くか
// ------------------
// 前向き検証の価値は「凍結後にパラメータを差し替えられないこと」だが、localStorage 保存では
//   - 端末を変えれば消える / ブラウザのデータを消せば消える
//   - 1年前に凍結した予測がどうなったか、という資産が原理的に生まれない
// という穴が残る。この資産は「時間」しか材料にできず、後から作ることができない
// （docs/asset-utilization.md 2-6・優先順位1）。したがって保存先をサーバに移す。
//
// 整合性のための設計
// ------------------
//  - 凍結日 frozen_at は**サーバが決める**（クライアント時計の巻き戻しで遡って凍結できない）。
//    ただし旧 localStorage 記録の取り込みだけは元の日付を保ち、origin='local-import' で区別する。
//  - 同一の予測は二重に凍結できない（UNIQUE 制約）。条件を変えて記録し直せると検証の意味が消える。
//  - 所有者は匿名 UUID（cookie）。認証は無いが、記録そのものは端末に依存せず残る。

import { sql } from "@vercel/postgres";

let tablesReady = false;

async function ensureTables() {
  if (tablesReady) return;
  // エッジ台帳（prospective-ledger.ts）
  await sql`
    CREATE TABLE IF NOT EXISTS prospective_ledger (
      owner_id UUID NOT NULL,
      id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      edge_label TEXT NOT NULL,
      direction TEXT NOT NULL,
      frozen_at TEXT NOT NULL,
      freeze_data_end TEXT NOT NULL,
      n_is INTEGER NOT NULL,
      mu_is DOUBLE PRECISION NOT NULL,
      sigma_is DOUBLE PRECISION NOT NULL,
      sharpe_is DOUBLE PRECISION NOT NULL,
      trades_per_year DOUBLE PRECISION NOT NULL,
      origin TEXT NOT NULL DEFAULT 'server',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, id),
      UNIQUE (owner_id, ticker, edge_id)
    )
  `;
  // アナログ予測台帳（analog-ledger.ts）
  await sql`
    CREATE TABLE IF NOT EXISTS analog_ledger (
      owner_id UUID NOT NULL,
      id TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      ticker TEXT NOT NULL,
      name TEXT,
      frozen_at TEXT NOT NULL,
      as_of TEXT NOT NULL,
      label TEXT NOT NULL,
      settings JSONB NOT NULL,
      pred_path JSONB NOT NULL,
      pred_p25 JSONB NOT NULL,
      pred_p75 JSONB NOT NULL,
      pred_median DOUBLE PRECISION NOT NULL,
      pred_mfe DOUBLE PRECISION NOT NULL,
      pred_mae DOUBLE PRECISION NOT NULL,
      n_selected INTEGER NOT NULL,
      n_eff DOUBLE PRECISION NOT NULL,
      diff_median DOUBLE PRECISION NOT NULL,
      diff_p DOUBLE PRECISION NOT NULL,
      novelty DOUBLE PRECISION NOT NULL,
      win_rate DOUBLE PRECISION NOT NULL,
      origin TEXT NOT NULL DEFAULT 'server',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (owner_id, id),
      UNIQUE (owner_id, entry_key)
    )
  `;
  tablesReady = true;
}

/** 凍結日はサーバ時刻（JST）で決める。クライアントの日付は信用しない。 */
export function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// ─────────────────────── エッジ台帳 ───────────────────────

export interface ProspectiveRow {
  id: string;
  ticker: string;
  edgeId: string;
  edgeLabel: string;
  direction: string;
  frozenAt: string;
  freezeDataEnd: string;
  nIS: number;
  muIS: number;
  sigmaIS: number;
  sharpeIS: number;
  tradesPerYear: number;
}

type ProspectiveDbRow = {
  id: string; ticker: string; edge_id: string; edge_label: string; direction: string;
  frozen_at: string; freeze_data_end: string; n_is: number; mu_is: number;
  sigma_is: number; sharpe_is: number; trades_per_year: number;
};

function mapProspective(r: ProspectiveDbRow): ProspectiveRow {
  return {
    id: r.id, ticker: r.ticker, edgeId: r.edge_id, edgeLabel: r.edge_label,
    direction: r.direction, frozenAt: r.frozen_at, freezeDataEnd: r.freeze_data_end,
    nIS: Number(r.n_is), muIS: Number(r.mu_is), sigmaIS: Number(r.sigma_is),
    sharpeIS: Number(r.sharpe_is), tradesPerYear: Number(r.trades_per_year),
  };
}

export async function listProspective(ownerId: string): Promise<ProspectiveRow[]> {
  await ensureTables();
  const { rows } = await sql<ProspectiveDbRow>`
    SELECT id, ticker, edge_id, edge_label, direction, frozen_at, freeze_data_end,
           n_is, mu_is, sigma_is, sharpe_is, trades_per_year
    FROM prospective_ledger
    WHERE owner_id = ${ownerId}::uuid
    ORDER BY created_at ASC
  `;
  return rows.map(mapProspective);
}

/** 追加。origin='server' なら frozen_at はサーバ日付で上書きする。 */
export async function insertProspective(
  ownerId: string, entries: ProspectiveRow[], origin: "server" | "local-import"
): Promise<number> {
  if (entries.length === 0) return 0;
  await ensureTables();
  const serverDate = todayJst();
  let added = 0;
  for (const e of entries) {
    const frozenAt = origin === "server" ? serverDate : e.frozenAt;
    const { rowCount } = await sql`
      INSERT INTO prospective_ledger (
        owner_id, id, ticker, edge_id, edge_label, direction, frozen_at, freeze_data_end,
        n_is, mu_is, sigma_is, sharpe_is, trades_per_year, origin
      ) VALUES (
        ${ownerId}::uuid, ${e.id}, ${e.ticker}, ${e.edgeId}, ${e.edgeLabel}, ${e.direction},
        ${frozenAt}, ${e.freezeDataEnd}, ${e.nIS}, ${e.muIS}, ${e.sigmaIS}, ${e.sharpeIS},
        ${e.tradesPerYear}, ${origin}
      )
      ON CONFLICT DO NOTHING
    `;
    added += rowCount ?? 0;
  }
  return added;
}

export async function deleteProspective(ownerId: string, id: string): Promise<void> {
  await ensureTables();
  await sql`DELETE FROM prospective_ledger WHERE owner_id = ${ownerId}::uuid AND id = ${id}`;
}

// ─────────────────────── アナログ台帳 ───────────────────────

export interface AnalogRow {
  id: string;
  entryKey: string;
  ticker: string;
  name?: string;
  frozenAt: string;
  asOf: string;
  label: string;
  settings: unknown;
  predPath: number[];
  predP25: number[];
  predP75: number[];
  predMedian: number;
  predMfe: number;
  predMae: number;
  nSelected: number;
  nEff: number;
  diffMedian: number;
  diffP: number;
  novelty: number;
  winRate: number;
}

type AnalogDbRow = {
  id: string; entry_key: string; ticker: string; name: string | null;
  frozen_at: string; as_of: string; label: string; settings: unknown;
  pred_path: number[]; pred_p25: number[]; pred_p75: number[];
  pred_median: number; pred_mfe: number; pred_mae: number;
  n_selected: number; n_eff: number; diff_median: number; diff_p: number;
  novelty: number; win_rate: number;
};

function mapAnalog(r: AnalogDbRow): AnalogRow {
  return {
    id: r.id, entryKey: r.entry_key, ticker: r.ticker, name: r.name ?? undefined,
    frozenAt: r.frozen_at, asOf: r.as_of, label: r.label, settings: r.settings,
    predPath: r.pred_path, predP25: r.pred_p25, predP75: r.pred_p75,
    predMedian: Number(r.pred_median), predMfe: Number(r.pred_mfe), predMae: Number(r.pred_mae),
    nSelected: Number(r.n_selected), nEff: Number(r.n_eff), diffMedian: Number(r.diff_median),
    diffP: Number(r.diff_p), novelty: Number(r.novelty), winRate: Number(r.win_rate),
  };
}

export async function listAnalog(ownerId: string): Promise<AnalogRow[]> {
  await ensureTables();
  const { rows } = await sql<AnalogDbRow>`
    SELECT id, entry_key, ticker, name, frozen_at, as_of, label, settings,
           pred_path, pred_p25, pred_p75, pred_median, pred_mfe, pred_mae,
           n_selected, n_eff, diff_median, diff_p, novelty, win_rate
    FROM analog_ledger
    WHERE owner_id = ${ownerId}::uuid
    ORDER BY created_at ASC
  `;
  return rows.map(mapAnalog);
}

export async function insertAnalog(
  ownerId: string, entries: AnalogRow[], origin: "server" | "local-import"
): Promise<number> {
  if (entries.length === 0) return 0;
  await ensureTables();
  const serverDate = todayJst();
  let added = 0;
  for (const e of entries) {
    const frozenAt = origin === "server" ? serverDate : e.frozenAt;
    const { rowCount } = await sql`
      INSERT INTO analog_ledger (
        owner_id, id, entry_key, ticker, name, frozen_at, as_of, label, settings,
        pred_path, pred_p25, pred_p75, pred_median, pred_mfe, pred_mae,
        n_selected, n_eff, diff_median, diff_p, novelty, win_rate, origin
      ) VALUES (
        ${ownerId}::uuid, ${e.id}, ${e.entryKey}, ${e.ticker}, ${e.name ?? null},
        ${frozenAt}, ${e.asOf}, ${e.label}, ${JSON.stringify(e.settings)}::jsonb,
        ${JSON.stringify(e.predPath)}::jsonb, ${JSON.stringify(e.predP25)}::jsonb,
        ${JSON.stringify(e.predP75)}::jsonb, ${e.predMedian}, ${e.predMfe}, ${e.predMae},
        ${e.nSelected}, ${e.nEff}, ${e.diffMedian}, ${e.diffP}, ${e.novelty}, ${e.winRate},
        ${origin}
      )
      ON CONFLICT DO NOTHING
    `;
    added += rowCount ?? 0;
  }
  return added;
}

export async function deleteAnalog(ownerId: string, id: string): Promise<void> {
  await ensureTables();
  await sql`DELETE FROM analog_ledger WHERE owner_id = ${ownerId}::uuid AND id = ${id}`;
}

export async function deleteAllAnalog(ownerId: string): Promise<void> {
  await ensureTables();
  await sql`DELETE FROM analog_ledger WHERE owner_id = ${ownerId}::uuid`;
}
