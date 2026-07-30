// 匿名オーナーID（台帳の所有者）の発行と引き継ぎ。
//   GET  … 現在のIDを返す（無ければ発行して cookie に載せる）。復元キーの表示に使う。
//   POST … 別端末で発行済みのIDを cookie に設定し、その台帳を引き継ぐ。
import { NextRequest, NextResponse } from "next/server";
import { isOwnerId, resolveOwner, setOwnerCookie, dbConfigured } from "../../../lib/ledger-owner";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const { ownerId, fresh } = resolveOwner(request);
  const res = NextResponse.json({ ownerId, configured: dbConfigured() });
  if (fresh) setOwnerCookie(res, ownerId);
  return res;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエスト形式が不正です" }, { status: 400 });
  }
  const ownerId = (body as { ownerId?: unknown })?.ownerId;
  if (!isOwnerId(ownerId)) {
    return NextResponse.json({ error: "復元キーの形式が正しくありません" }, { status: 400 });
  }
  // 存在確認はしない。空の台帳を引き継ぐこともあり得るし、
  // 「そのIDに記録があるか」を答えると総当たりで他人の記録の有無を探れてしまう。
  return setOwnerCookie(NextResponse.json({ ownerId, configured: dbConfigured() }), ownerId);
}
