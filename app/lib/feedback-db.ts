import { sql } from "@vercel/postgres";

// フィードバック保存先テーブル。初回アクセス時に存在しなければ自動作成する。
let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      comment TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  tableReady = true;
}

export async function insertFeedback(comment: string, userAgent: string | null) {
  await ensureTable();
  await sql`
    INSERT INTO feedback (comment, user_agent)
    VALUES (${comment}, ${userAgent})
  `;
}

export type FeedbackRow = {
  id: number;
  comment: string;
  user_agent: string | null;
  created_at: string;
};

export async function listFeedback(limit = 200): Promise<FeedbackRow[]> {
  await ensureTable();
  const { rows } = await sql<FeedbackRow>`
    SELECT id, comment, user_agent, created_at
    FROM feedback
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}
