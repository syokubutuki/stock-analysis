// 日次トリアージ (方向E)
// 主要シグナルのスナップショットを localStorage に保存し、
// 「前回の基準から何が変わったか」を差分として算出する。
// 基準は自動上書きしない(ユーザーが「現在を基準に保存」で更新)ため、
// 差分は次に基準を更新するまで残り続ける。

import { SignalDigest } from "./signal-digest";

export interface SnapshotEntry {
  ticker: string;
  asOf: string;
  regime: string;
  direction: string;
  badge: string; // 保有/狙いの判定バッジ
  changePoint: boolean;
}

export interface PortfolioSnapshot {
  savedAt: number;
  entries: Record<string, SnapshotEntry>;
}

export interface DiffResult {
  changed: boolean;
  reasons: string[];
  isNew: boolean; // 基準に存在しない新規銘柄
}

const STORAGE_KEY = "stock-analysis-portfolio-snapshot";

export function getSnapshot(): PortfolioSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PortfolioSnapshot;
  } catch {
    return null;
  }
}

export function saveSnapshot(
  rows: { digest: SignalDigest; badge: string }[]
): PortfolioSnapshot {
  const entries: Record<string, SnapshotEntry> = {};
  for (const { digest, badge } of rows) {
    entries[digest.ticker] = {
      ticker: digest.ticker,
      asOf: digest.asOf,
      regime: digest.regime,
      direction: digest.direction,
      badge,
      changePoint: digest.changePoint,
    };
  }
  const snap: PortfolioSnapshot = { savedAt: Date.now(), entries };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch {}
  return snap;
}

export function diffAgainstSnapshot(
  digest: SignalDigest,
  badge: string,
  snapshot: PortfolioSnapshot | null
): DiffResult {
  if (!snapshot) return { changed: false, reasons: [], isNew: false };
  const prev = snapshot.entries[digest.ticker];
  if (!prev) return { changed: true, reasons: ["新規"], isNew: true };

  const reasons: string[] = [];
  if (prev.direction !== digest.direction) {
    reasons.push(`方向 ${prev.direction}→${digest.direction}`);
  }
  if (prev.regime !== digest.regime) {
    reasons.push(`レジーム ${prev.regime}→${digest.regime}`);
  }
  if (prev.badge !== badge) {
    reasons.push(`判定 ${prev.badge}→${badge}`);
  }
  if (!prev.changePoint && digest.changePoint) {
    reasons.push("変化点が新たに発火");
  }
  return { changed: reasons.length > 0, reasons, isNew: false };
}
