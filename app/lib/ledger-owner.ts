// 台帳の所有者識別（匿名オーナーID）。
//
// このアプリに認証は無い。それでも台帳をサーバに置くために、サーバが発行する UUID を
// cookie に持たせて所有者とする。ログイン不要のまま
//   - 端末のデータを消しても記録は残る（cookie を消すと自分からは見えなくなるが、復元キーで戻せる）
//   - 運営側に「いつ何が凍結され、その後どうなったか」という時系列が積み上がる
// を成立させる。cookie は httpOnly（XSS で持ち去られないため）で、
// 復元キーとしての UUID は /api/ledger/owner が明示的に返したときだけ画面に出る。

import { NextResponse } from "next/server";

export const OWNER_COOKIE = "ledger_owner";
const MAX_AGE = 400 * 24 * 3600; // ブラウザが受け付ける cookie 寿命の上限（400日）

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOwnerId(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** リクエストの cookie から所有者IDを取り出す。無ければ新規発行する（fresh=true）。 */
export function resolveOwner(req: Request): { ownerId: string; fresh: boolean } {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === OWNER_COOKIE) {
      const v = decodeURIComponent(rest.join("="));
      if (isOwnerId(v)) return { ownerId: v, fresh: false };
    }
  }
  return { ownerId: crypto.randomUUID(), fresh: true };
}

/** 所有者IDをレスポンスの cookie に載せる。 */
export function setOwnerCookie<T>(res: NextResponse<T>, ownerId: string): NextResponse<T> {
  res.cookies.set(OWNER_COOKIE, ownerId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}

/** POSTGRES_URL が無い環境（ローカル開発）では 503 を返し、クライアントを localStorage に退避させる。
 *  @vercel/postgres が既定で読むのはこの2つなので、他の名前は「設定済み」と見なさない。 */
export function dbConfigured(): boolean {
  return !!(process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING);
}

export function dbUnavailable() {
  return NextResponse.json(
    { error: "台帳サーバが未設定です", code: "db_unconfigured" },
    { status: 503 }
  );
}
