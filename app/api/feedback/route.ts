import { NextRequest, NextResponse } from "next/server";
import { insertFeedback, listFeedback } from "../../lib/feedback-db";

// Postgres を使うため Node ランタイムで動かす
export const runtime = "nodejs";

const MAX_LEN = 2000;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "リクエスト形式が不正です" }, { status: 400 });
  }

  const raw = (body as { comment?: unknown })?.comment;
  const comment = typeof raw === "string" ? raw.trim() : "";

  if (!comment) {
    return NextResponse.json({ error: "コメントを入力してください" }, { status: 400 });
  }
  if (comment.length > MAX_LEN) {
    return NextResponse.json(
      { error: `コメントは${MAX_LEN}文字以内で入力してください` },
      { status: 400 }
    );
  }

  const ua = request.headers.get("user-agent")?.slice(0, 300) ?? null;

  try {
    await insertFeedback(comment, ua);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Feedback insert error:", e);
    return NextResponse.json(
      { error: "送信に失敗しました。時間をおいて再度お試しください。" },
      { status: 500 }
    );
  }
}

// 管理者用の一覧取得。環境変数 FEEDBACK_ADMIN_TOKEN と一致する token が必要。
export async function GET(request: NextRequest) {
  const token = process.env.FEEDBACK_ADMIN_TOKEN;
  const provided = request.nextUrl.searchParams.get("token");

  if (!token || provided !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const items = await listFeedback(200);
    return NextResponse.json({ items });
  } catch (e) {
    console.error("Feedback list error:", e);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500 });
  }
}
