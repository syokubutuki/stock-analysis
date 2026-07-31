import { LEGACY_ORIGIN, SITE_ORIGIN } from "./site-url";

export const DOMAIN_MIGRATION_CHANNEL = "kabugenron-domain-migration:v1";
export const MAX_TRANSFER_BYTES = 2 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIGRATION_FLAGS = new Set([
  "prospective-ledger:migrated:v1",
  "analog-ledger:migrated:v1",
]);
const ALLOWED_STORAGE_PREFIXES = [
  "sa:",
  "stock-analysis-",
  "prospective-ledger:",
  "analog-ledger:",
  "test-ledger:",
  "unifiedChart.",
  "weeklyAnalog",
  "pf-entry-sizing-",
  "cross-table-",
];

export interface DomainMigrationPayload {
  version: 1;
  ownerId: string;
  storage: Record<string, string>;
}

export type DomainMigrationMessage =
  | { channel: typeof DOMAIN_MIGRATION_CHANNEL; type: "ready" }
  | { channel: typeof DOMAIN_MIGRATION_CHANNEL; type: "payload"; payload: DomainMigrationPayload }
  | { channel: typeof DOMAIN_MIGRATION_CHANNEL; type: "complete"; importedKeys: number }
  | { channel: typeof DOMAIN_MIGRATION_CHANNEL; type: "error"; message: string };

export function isAllowedMigrationStorageKey(key: string): boolean {
  return (
    !MIGRATION_FLAGS.has(key) &&
    ALLOWED_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export function collectDomainMigrationPayload(ownerId: string): DomainMigrationPayload {
  if (!UUID_RE.test(ownerId)) throw new Error("匿名キーの形式が正しくありません");

  const storage: Record<string, string> = {};
  let bytes = 0;
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key || !isAllowedMigrationStorageKey(key)) continue;
    const value = window.localStorage.getItem(key);
    if (value === null) continue;
    const entryBytes = new Blob([key, value]).size;
    if (bytes + entryBytes > MAX_TRANSFER_BYTES) {
      throw new Error("移行データが2MBを超えています。復元キーを控えてから移行してください");
    }
    storage[key] = value;
    bytes += entryBytes;
  }

  return { version: 1, ownerId, storage };
}

export function validateDomainMigrationPayload(value: unknown): value is DomainMigrationPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<DomainMigrationPayload>;
  if (payload.version !== 1 || typeof payload.ownerId !== "string" || !UUID_RE.test(payload.ownerId)) {
    return false;
  }
  if (!payload.storage || typeof payload.storage !== "object" || Array.isArray(payload.storage)) {
    return false;
  }

  let bytes = 0;
  for (const [key, entry] of Object.entries(payload.storage)) {
    if (!isAllowedMigrationStorageKey(key) || typeof entry !== "string") return false;
    bytes += new Blob([key, entry]).size;
    if (bytes > MAX_TRANSFER_BYTES) return false;
  }
  return true;
}

export function applyDomainMigrationStorage(payload: DomainMigrationPayload): number {
  let imported = 0;
  for (const [key, value] of Object.entries(payload.storage)) {
    if (!isAllowedMigrationStorageKey(key)) continue;
    window.localStorage.setItem(key, value);
    imported += 1;
  }
  // 旧ホストの「移行済み」は新ホストには引き継がない。未同期の台帳を新ホストから
  // サーバーへ送れるよう、既存の一度きりインポートを再実行させる。
  for (const key of MIGRATION_FLAGS) window.localStorage.removeItem(key);
  return imported;
}

export function isDomainMigrationMessage(value: unknown): value is DomainMigrationMessage {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { channel?: unknown }).channel === DOMAIN_MIGRATION_CHANNEL &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export function expectedMigrationPeerOrigin(receiving: boolean): string {
  return receiving ? LEGACY_ORIGIN : SITE_ORIGIN;
}
