// 前向き検証台帳の保存層（クライアント側の窓口）。
//
// 保存先は **サーバ(Postgres)を正** とする。前向き検証の資産は「時間」しか材料にできず、
// localStorage 保存では端末を変えた時点でゼロに戻ってしまうため（docs/asset-utilization.md 2-6）。
//
// ただし、この窓口は以下の場合に localStorage へ黙って退避する:
//   - POSTGRES_URL が無い環境（ローカル開発）→ API が 503 code:"db_unconfigured"
//   - API が落ちている / オフライン
// 退避中でも凍結・採点はそのまま動く。サーバが復帰した最初の読み込みで、
// 手元に残っていた記録は一度だけサーバへ送られる（origin='local-import' として元の凍結日を保つ）。

import {
  LedgerEntry,
  loadLocalLedger,
  saveLocalLedger,
} from "./prospective-ledger";
import {
  AnalogLedgerEntry,
  entryKey,
  loadLocalAnalogLedger,
  saveLocalAnalogLedger,
} from "./analog-ledger";

export type LedgerSource = "server" | "local";

export interface LedgerState<T> {
  entries: T[];
  source: LedgerSource;
  ownerId: string | null;
  /** source==="local" のとき、なぜサーバに載っていないか（画面に出す用） */
  reason?: string;
}

const MIGRATED_PROSPECTIVE = "prospective-ledger:migrated:v1";
const MIGRATED_ANALOG = "analog-ledger:migrated:v1";

// セッション中に一度サーバが駄目だと分かったら、以後の操作で毎回叩き直さない。
let serverDown: string | null = null;
let cachedOwnerId: string | null = null;
let ownerPromise: Promise<unknown> | null = null;

export function resetServerProbe() {
  serverDown = null;
  ownerPromise = null;
}

export function currentOwnerId(): string | null {
  return cachedOwnerId;
}

type ApiOk<T> = { ok: true; data: T };
type ApiFail = { ok: false; reason: string };

async function callApi<T>(path: string, init?: RequestInit): Promise<ApiOk<T> | ApiFail> {
  if (serverDown) return { ok: false, reason: serverDown };
  try {
    const res = await fetch(path, { ...init, credentials: "same-origin" });
    if (!res.ok) {
      let code = "";
      try {
        code = ((await res.json()) as { code?: string }).code ?? "";
      } catch {
        /* ボディ無しでも判定は status で足りる */
      }
      const reason =
        code === "db_unconfigured"
          ? "台帳サーバが未設定のため、この端末にのみ保存しています"
          : `台帳サーバに接続できないため、この端末にのみ保存しています（${res.status}）`;
      serverDown = reason;
      return { ok: false, reason };
    }
    const data = (await res.json()) as T & { ownerId?: string };
    if (data.ownerId) cachedOwnerId = data.ownerId;
    return { ok: true, data };
  } catch {
    const reason = "台帳サーバに接続できないため、この端末にのみ保存しています（オフライン）";
    serverDown = reason;
    return { ok: false, reason };
  }
}

// 台帳を触る前に、必ず所有者IDの発行を1本にまとめて済ませておく。
// エッジ台帳とアナログ台帳が同時に初回リクエストを出すと、それぞれ別の UUID を発行されて
// 同じ利用者の記録が2つの所有者に割れる——移行で防ごうとしている事故そのものになる。
async function ensureOwner(): Promise<void> {
  if (cachedOwnerId || serverDown) return;
  if (!ownerPromise) ownerPromise = callApi<{ ownerId: string }>("/api/ledger/owner");
  await ownerPromise;
}

function flagged(key: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return true;
  }
}
function setFlag(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    /* 保存できなくても移行が二重に走るだけ。ON CONFLICT で弾かれる */
  }
}

// ───────────────────────── エッジ台帳 ─────────────────────────

type ProspectiveResponse = { ownerId: string; entries: LedgerEntry[]; added?: number; skipped?: number };

function localProspectiveState(reason: string): LedgerState<LedgerEntry> {
  return { entries: loadLocalLedger(), source: "local", ownerId: null, reason };
}

/** 初回読み込み。サーバが生きていれば、未移行の localStorage 記録を一度だけ送る。 */
export async function loadProspectiveLedger(): Promise<LedgerState<LedgerEntry>> {
  await ensureOwner();
  const got = await callApi<ProspectiveResponse>("/api/ledger/prospective");
  if (!got.ok) return localProspectiveState(got.reason);

  let entries = got.data.entries;
  if (!flagged(MIGRATED_PROSPECTIVE)) {
    const local = loadLocalLedger();
    if (local.length > 0) {
      const up = await callApi<ProspectiveResponse>("/api/ledger/prospective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: local, origin: "local-import" }),
      });
      if (up.ok) entries = up.data.entries;
    }
    setFlag(MIGRATED_PROSPECTIVE);
  }
  return { entries, source: "server", ownerId: got.data.ownerId };
}

export async function saveProspectiveEntry(entry: LedgerEntry): Promise<LedgerState<LedgerEntry>> {
  await ensureOwner();
  const got = await callApi<ProspectiveResponse>("/api/ledger/prospective", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: [entry] }),
  });
  if (got.ok) return { entries: got.data.entries, source: "server", ownerId: got.data.ownerId };
  const next = [...loadLocalLedger(), entry];
  saveLocalLedger(next);
  return { entries: next, source: "local", ownerId: null, reason: got.reason };
}

export async function removeProspectiveEntry(id: string): Promise<LedgerState<LedgerEntry>> {
  await ensureOwner();
  const got = await callApi<ProspectiveResponse>(`/api/ledger/prospective?id=${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (got.ok) return { entries: got.data.entries, source: "server", ownerId: got.data.ownerId };
  const next = loadLocalLedger().filter((e) => e.id !== id);
  saveLocalLedger(next);
  return { entries: next, source: "local", ownerId: null, reason: got.reason };
}

// ───────────────────────── アナログ台帳 ─────────────────────────

type AnalogResponse = { ownerId: string; entries: AnalogLedgerEntry[]; added?: number; skipped?: number };

// サーバは entry_key を必須にしているので、送る直前に付ける（保存形式に鍵は残さない）。
function withKeys(entries: AnalogLedgerEntry[]) {
  return entries.map((e) => ({ ...e, entryKey: entryKey(e.ticker, e.asOf, e.settings) }));
}

function localAnalogState(reason: string): LedgerState<AnalogLedgerEntry> {
  return { entries: loadLocalAnalogLedger(), source: "local", ownerId: null, reason };
}

export async function loadAnalogLedgerStore(): Promise<LedgerState<AnalogLedgerEntry>> {
  await ensureOwner();
  const got = await callApi<AnalogResponse>("/api/ledger/analog");
  if (!got.ok) return localAnalogState(got.reason);

  let entries = got.data.entries;
  if (!flagged(MIGRATED_ANALOG)) {
    const local = loadLocalAnalogLedger();
    if (local.length > 0) {
      const up = await callApi<AnalogResponse>("/api/ledger/analog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: withKeys(local), origin: "local-import" }),
      });
      if (up.ok) entries = up.data.entries;
    }
    setFlag(MIGRATED_ANALOG);
  }
  return { entries, source: "server", ownerId: got.data.ownerId };
}

/** 新規記録を追加する。戻り値の added はサーバが実際に受け付けた件数（重複は弾かれる）。 */
export async function saveAnalogEntries(
  toAdd: AnalogLedgerEntry[], origin: "server" | "local-import" = "server"
): Promise<LedgerState<AnalogLedgerEntry> & { added: number }> {
  await ensureOwner();
  if (toAdd.length === 0) {
    const cur = await loadAnalogLedgerStore();
    return { ...cur, added: 0 };
  }
  const got = await callApi<AnalogResponse>("/api/ledger/analog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries: withKeys(toAdd), origin }),
  });
  if (got.ok) {
    return { entries: got.data.entries, source: "server", ownerId: got.data.ownerId, added: got.data.added ?? toAdd.length };
  }
  // フォールバック保存でも「同じ銘柄×基準日×設定は二度と記録できない」を守る
  // （サーバ側は UNIQUE 制約で担保している）。
  const current = loadLocalAnalogLedger();
  const seen = new Set(current.map((e) => entryKey(e.ticker, e.asOf, e.settings)));
  const fresh = toAdd.filter((e) => {
    const k = entryKey(e.ticker, e.asOf, e.settings);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const next = [...current, ...fresh];
  saveLocalAnalogLedger(next);
  return { entries: next, source: "local", ownerId: null, reason: got.reason, added: fresh.length };
}

export async function removeAnalogEntryStore(id: string): Promise<LedgerState<AnalogLedgerEntry>> {
  await ensureOwner();
  const got = await callApi<AnalogResponse>(`/api/ledger/analog?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (got.ok) return { entries: got.data.entries, source: "server", ownerId: got.data.ownerId };
  const next = loadLocalAnalogLedger().filter((e) => e.id !== id);
  saveLocalAnalogLedger(next);
  return { entries: next, source: "local", ownerId: null, reason: got.reason };
}

export async function clearAnalogLedgerStore(): Promise<LedgerState<AnalogLedgerEntry>> {
  await ensureOwner();
  const got = await callApi<AnalogResponse>("/api/ledger/analog?all=1", { method: "DELETE" });
  if (got.ok) return { entries: got.data.entries, source: "server", ownerId: got.data.ownerId };
  saveLocalAnalogLedger([]);
  return { entries: [], source: "local", ownerId: null, reason: got.reason };
}

// ───────────────────────── オーナーID（復元キー） ─────────────────────────

export async function fetchOwnerId(): Promise<string | null> {
  await ensureOwner();
  return cachedOwnerId;
}

/** 別端末で発行された復元キーに切り替える。成功したら台帳を読み直すこと。 */
export async function adoptOwnerId(ownerId: string): Promise<{ ok: boolean; error?: string }> {
  const adopted = await setOwnerId(ownerId);
  if (!adopted.ok) return adopted;
  // 通常の端末引き継ぎでは、引き継ぎ先のサーバー台帳だけを表示し、この端末に残る
  // 別所有者のローカル台帳を誤って混ぜない。
  setFlag(MIGRATED_PROSPECTIVE);
  setFlag(MIGRATED_ANALOG);
  return { ok: true };
}

async function setOwnerId(ownerId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/ledger/owner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ownerId: ownerId.trim() }),
    });
    if (!res.ok) {
      const msg = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      return { ok: false, error: msg ?? "引き継ぎに失敗しました" };
    }
    cachedOwnerId = ownerId.trim();
    return { ok: true };
  } catch {
    return { ok: false, error: "台帳サーバに接続できません" };
  }
}

/**
 * 旧ドメインからの移行専用。所有者を維持しつつ、同じ利用者のローカル台帳は
 * load* の既存インポート処理へ渡すため、移行済みフラグを立てない。
 */
export async function adoptOwnerIdForDomainMigration(
  ownerId: string
): Promise<{ ok: boolean; error?: string }> {
  return setOwnerId(ownerId);
}

/** 新ドメインへコピーした未同期台帳を、既存の冪等なAPI経由でサーバーへ取り込む。 */
export async function importDomainMigratedLedgers(): Promise<void> {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(MIGRATED_PROSPECTIVE);
    window.localStorage.removeItem(MIGRATED_ANALOG);
  }
  await loadProspectiveLedger();
  await loadAnalogLedgerStore();
}
