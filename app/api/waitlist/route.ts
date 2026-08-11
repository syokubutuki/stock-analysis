import { NextRequest, NextResponse } from "next/server";
import {
  insertWaitlistEmail,
  isDbConfigured,
  listWaitlist,
} from "../../lib/waitlist-db";

// Postgres を使うため Node ランタイムで動かす
export const runtime = "nodejs";

const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Submission = {
  email: string;
  consent: boolean;
};

function isFormSubmission(request: NextRequest): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  return (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  );
}

async function readSubmission(request: NextRequest): Promise<Submission> {
  if (isFormSubmission(request)) {
    const form = await request.formData();
    const rawEmail = form.get("email");
    return {
      email: typeof rawEmail === "string" ? rawEmail.trim() : "",
      consent: form.get("consent") === "yes",
    };
  }

  const body = (await request.json()) as {
    email?: unknown;
    consent?: unknown;
  };
  return {
    email: typeof body?.email === "string" ? body.email.trim() : "",
    consent: body?.consent === true,
  };
}

function respond(
  request: NextRequest,
  waitlistStatus: string,
  body: Record<string, unknown>,
  status: number
) {
  if (isFormSubmission(request)) {
    const url = new URL("/pricing", request.url);
    url.searchParams.set("waitlist", waitlistStatus);
    url.hash = "waitlist";
    return NextResponse.redirect(url, { status: 303 });
  }
  return NextResponse.json(body, { status });
}

export async function POST(request: NextRequest) {
  let submission: Submission;
  try {
    submission = await readSubmission(request);
  } catch {
    return respond(
      request,
      "invalid_request",
      { error: "リクエスト形式が不正です" },
      400
    );
  }

  if (!submission.email) {
    return respond(
      request,
      "invalid_email",
      { error: "メールアドレスを入力してください" },
      400
    );
  }
  if (submission.email.length > MAX_EMAIL_LENGTH) {
    return respond(
      request,
      "email_too_long",
      { error: `メールアドレスは${MAX_EMAIL_LENGTH}文字以内で入力してください` },
      400
    );
  }
  if (!EMAIL_PATTERN.test(submission.email)) {
    return respond(
      request,
      "invalid_email",
      { error: "メールアドレスの形式を確認してください" },
      400
    );
  }
  if (!submission.consent) {
    return respond(
      request,
      "consent_required",
      { error: "利用目的を確認し、同意してください" },
      400
    );
  }
  if (!isDbConfigured()) {
    return respond(
      request,
      "db_unconfigured",
      { error: "待機リストの保存先が未設定です", code: "db_unconfigured" },
      503
    );
  }

  try {
    await insertWaitlistEmail(submission.email);
    return respond(request, "registered", { ok: true }, 200);
  } catch (error) {
    console.error("Waitlist insert error:", error);
    return respond(
      request,
      "error",
      { error: "登録に失敗しました。時間をおいて再度お試しください。" },
      500
    );
  }
}

// 管理者用の一覧取得。feedback と同じ FEEDBACK_ADMIN_TOKEN で保護する。
export async function GET(request: NextRequest) {
  const token = process.env.FEEDBACK_ADMIN_TOKEN;
  const provided = request.nextUrl.searchParams.get("token");

  if (!token || provided !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isDbConfigured()) {
    return NextResponse.json(
      { error: "待機リストの保存先が未設定です", code: "db_unconfigured" },
      { status: 503 }
    );
  }

  try {
    const items = await listWaitlist(200);
    return NextResponse.json({ items });
  } catch (error) {
    console.error("Waitlist list error:", error);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500 });
  }
}
