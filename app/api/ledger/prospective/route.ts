// エッジの前向き検証台帳（prospective-ledger）のサーバ保存。
import { NextRequest, NextResponse } from "next/server";
import { resolveOwner, setOwnerCookie, dbConfigured, dbUnavailable } from "../../../lib/ledger-owner";
import { listProspective, insertProspective, deleteProspective, type ProspectiveRow } from "../../../lib/ledger-db";

export const runtime = "nodejs";

const MAX_BATCH = 500;

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}

function parseEntry(raw: unknown): ProspectiveRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id, 200), ticker = str(o.ticker, 40), edgeId = str(o.edgeId, 120);
  const edgeLabel = str(o.edgeLabel, 300), frozenAt = str(o.frozenAt, 10), freezeDataEnd = str(o.freezeDataEnd, 10);
  const direction = o.direction === "long" || o.direction === "short" ? o.direction : null;
  const nIS = num(o.nIS), muIS = num(o.muIS), sigmaIS = num(o.sigmaIS);
  const sharpeIS = num(o.sharpeIS), tradesPerYear = num(o.tradesPerYear);
  if (!id || !ticker || !edgeId || !edgeLabel || !frozenAt || !freezeDataEnd || !direction) return null;
  if (nIS === null || muIS === null || sigmaIS === null || sharpeIS === null || tradesPerYear === null) return null;
  return { id, ticker, edgeId, edgeLabel, direction, frozenAt, freezeDataEnd, nIS, muIS, sigmaIS, sharpeIS, tradesPerYear };
}

export async function GET(request: NextRequest) {
  if (!dbConfigured()) return dbUnavailable();
  const { ownerId, fresh } = resolveOwner(request);
  try {
    const entries = fresh ? [] : await listProspective(ownerId);
    const res = NextResponse.json({ ownerId, entries });
    if (fresh) setOwnerCookie(res, ownerId);
    return res;
  } catch (e) {
    console.error("prospective ledger list error:", e);
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
  const parsed: ProspectiveRow[] = [];
  for (const r of rawEntries) {
    const e = parseEntry(r);
    if (e) parsed.push(e);
  }
  // origin は「旧 localStorage 記録の取り込み」だけ元の凍結日を保つ。通常の凍結はサーバ日付。
  const origin = o?.origin === "local-import" ? "local-import" : "server";

  const { ownerId, fresh } = resolveOwner(request);
  try {
    const added = await insertProspective(ownerId, parsed, origin);
    const entries = await listProspective(ownerId);
    const res = NextResponse.json({
      ownerId, added, skipped: rawEntries.length - added, entries,
    });
    if (fresh) setOwnerCookie(res, ownerId);
    return res;
  } catch (e) {
    console.error("prospective ledger insert error:", e);
    return NextResponse.json({ error: "台帳への保存に失敗しました", code: "db_error" }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!dbConfigured()) return dbUnavailable();
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id が必要です" }, { status: 400 });
  const { ownerId, fresh } = resolveOwner(request);
  try {
    if (!fresh) await deleteProspective(ownerId, id);
    const entries = fresh ? [] : await listProspective(ownerId);
    return NextResponse.json({ ownerId, entries });
  } catch (e) {
    console.error("prospective ledger delete error:", e);
    return NextResponse.json({ error: "削除に失敗しました", code: "db_error" }, { status: 503 });
  }
}
