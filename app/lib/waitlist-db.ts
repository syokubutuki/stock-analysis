import { sql } from "@vercel/postgres";

// Pro 待機リスト。個人情報を最小限にするため、メールアドレス以外は保存しない。
let tableReady = false;

export function isDbConfigured(): boolean {
  return !!(process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING);
}

async function ensureTable() {
  if (tableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS waitlist (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT waitlist_email_unique UNIQUE (email)
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_lower_unique
    ON waitlist (LOWER(email))
  `;
  tableReady = true;
}

export async function insertWaitlistEmail(email: string): Promise<void> {
  await ensureTable();
  await sql`
    INSERT INTO waitlist (email)
    VALUES (${email})
    ON CONFLICT DO NOTHING
  `;
}

export type WaitlistRow = {
  id: number;
  email: string;
  created_at: string;
};

export async function listWaitlist(limit = 200): Promise<WaitlistRow[]> {
  await ensureTable();
  const { rows } = await sql<WaitlistRow>`
    SELECT id, email, created_at
    FROM waitlist
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows;
}
