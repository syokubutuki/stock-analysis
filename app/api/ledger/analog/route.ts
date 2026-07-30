// アナログ予測の前向き検証台帳（analog-ledger）のサーバ保存。
import { NextRequest, NextResponse } from "next/server";
import { resolveOwner, setOwnerCookie, dbConfigured, dbUnavailable } from "../../../lib/ledger-owner";
import { listAnalog, insertAnalog, deleteAnalog, deleteAllAnalog, type AnalogRow } from "../../../lib/ledger-db";

export const runtime = "nodejs";

const MAX_BATCH = 500;
const MAX_PATH = 400; // 予測経路の長さ上限（H は最大でも数十営業日）

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}
function numArr(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PATH) return null;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== "number" || !isFinite(x)) return null;
    out.push(x);
  }
  return out;
}

function parseEntry(raw: unknown): AnalogRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id, 200), entryKey = str(o.entryKey, 500), ticker = str(o.ticker, 40);
  const frozenAt = str(o.frozenAt, 10), asOf = str(o.asOf, 10), label = str(o.label, 300);
  const settings = o.settings && typeof o.settings === "object" ? o.settings : null;
  const predPath = numArr(o.predPath), predP25 = numArr(o.predP25), predP75 = numArr(o.predP75);
  const nums = {
    predMedian: num(o.predMedian), predMfe: num(o.predMfe), predMae: num(o.predMae),
    nSelected: num(o.nSelected), nEff: num(o.nEff), diffMedian: num(o.diffMedian),
    diffP: num(o.diffP), novelty: num(o.novelty), winRate: num(o.winRate),
  };
  if (!id || !entryKey || !ticker || !frozenAt || !asOf || !label || !settings) return null;
  if (!predPath || !predP25 || !predP75) return null;
  if (Object.values(nums).some((v) => v === null)) return null;
  const name = typeof o.name === "string" && o.name.length <= 200 ? o.name : undefined;
  return {
    id, entryKey, ticker, name, frozenAt, asOf, label, settings,
    predPath, predP25, predP75,
    predMedian: nums.predMedian!, predMfe: nums.predMfe!, predMae: nums.predMae!,
    nSelected: nums.nSelected!, nEff: nums.nEff!, diffMedian: nums.diffMedian!,
    diffP: nums.diffP!, novelty: nums.novelty!, winRate: nums.winRate!,
  };
}

export async function GET(request: NextRequest) {
  if (!dbConfigured()) return dbUnavailable();
  const { ownerId, fresh } = resolveOwner(request);
  try {
    const entries = fresh ? [] : await listAnalog(ownerId);
    const res = NextResponse.json({ ownerId, entries });
    if (fresh) setOwnerCookie(res, ownerId);
    return res;
  } catch (e) {
    console.error("analog ledger list error:", e);
    return NextResponse.json({ error: "台帳の取得に失敗しました", code: "db_error" }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  if (!dbConfigured()) return dbUnavailable();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエスト形式が不正です" }, { status: 400 });
  }
  const o = body as { entries?: unknown; origin?: unknown };
  const rawEntries = Array.isArray(o?.entries) ? o.entries : null;
  if (!rawEntries) return NextResponse.json({ error: "entries が配列ではありません" }, { status: 400 });
  if (rawEntries.length > MAX_BATCH) {
    return NextResponse.json({ error: `一度に登録できるのは${MAX_BATCH}件までです` }, { status: 413 });
  }
  const parsed: AnalogRow[] = [];
  for (const r of rawEntries) {
    const e = parseEntry(r);
    if (e) parsed.push(e);
  }
  const origin = o?.origin === "local-import" ? "local-import" : "server";

  const { ownerId, fresh } = resolveOwner(request);
  try {
    const added = await insertAnalog(ownerId, parsed, origin);
    const entries = await listAnalog(ownerId);
    const res = NextResponse.json({
      ownerId, added, skipped: rawEntries.length - added, entries,
    });
    if (fresh) setOwnerCookie(res, ownerId);
    return res;
  } catch (e) {
    console.error("analog ledger insert error:", e);
    return NextResponse.json({ error: "台帳への保存に失敗しました", code: "db_error" }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!dbConfigured()) return dbUnavailable();
  const id = request.nextUrl.searchParams.get("id");
  const all = request.nextUrl.searchParams.get("all") === "1";
  if (!id && !all) return NextResponse.json({ error: "id または all=1 が必要です" }, { status: 400 });
  const { ownerId, fresh } = resolveOwner(request);
  try {
    if (!fresh) {
      if (all) await deleteAllAnalog(ownerId);
      else await deleteAnalog(ownerId, id!);
    }
    const entries = fresh ? [] : await listAnalog(ownerId);
    return NextResponse.json({ ownerId, entries });
  } catch (e) {
    console.error("analog ledger delete error:", e);
    return NextResponse.json({ error: "削除に失敗しました", code: "db_error" }, { status: 503 });
  }
}
