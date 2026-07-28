// 「下側相関 ρ⁻ を測るパネル」から「建玉を決めるパネル」への受け渡し。
// ────────────────────────────────────────────────────────────────────────────
// pf-exceedance-corr で測った ρ⁻（ともに −θσ 以下の日の相関）は、そのままでは
// 「へえ」で終わってしまう。実際に効くのは**崖（pf-corr-drag）の ρ に入れて
// 建玉上限を引き直す**ところなので、その1クリックを繋ぐ。
//
// panel-nav.ts と同じ最小構成（window の CustomEvent ＋ localStorage）。
// localStorage に残すのは、パネルを開き直しても値が生きているようにするため
// （計測パネルを閉じても崖のボタンが残る）。銘柄構成が変わると意味を失うので
// tickers も一緒に保存し、受け取り側で照合できるようにしておく。

export const DOWNSIDE_RHO_EVENT = "sa:downside-rho";
const STORAGE_KEY = "sa:downside-rho";

export interface DownsideRho {
  /** 下側 exceedance correlation（全ペア平均）。 */
  rho: number;
  /** 上側 ρ⁺（対比のため）。 */
  rhoUp: number;
  /** 測った閾値 θ（標準偏差単位）。 */
  theta: number;
  /** 使ったリターン本数（窓）。 */
  periods: number;
  /** 測定に使った銘柄（構成が違えば参考値でしかない）。 */
  tickers: string[];
  /** 非対称性の両側 p（選択中のヌル）と、そのヌルの名前。 */
  asymP: number;
  nullLabel: string;
  /** 保存時刻（epoch ms）。 */
  savedAt: number;
}

function isValid(v: unknown): v is DownsideRho {
  if (!v || typeof v !== "object") return false;
  const d = v as Partial<DownsideRho>;
  return (
    typeof d.rho === "number" &&
    isFinite(d.rho) &&
    Array.isArray(d.tickers) &&
    typeof d.theta === "number"
  );
}

/** 測定側から呼ぶ。localStorage に書いてイベントを撃つ。 */
export function publishDownsideRho(payload: DownsideRho): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage が使えない環境ではイベントだけで伝える
  }
  window.dispatchEvent(new CustomEvent<DownsideRho>(DOWNSIDE_RHO_EVENT, { detail: payload }));
}

/** 受け取り側の初期値。保存が無ければ null。 */
export function loadDownsideRho(): DownsideRho | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 保存を消す（銘柄を入れ替えたときなどに測り直しを促す）。 */
export function clearDownsideRho(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 無視
  }
  window.dispatchEvent(new CustomEvent<DownsideRho | null>(DOWNSIDE_RHO_EVENT, { detail: null }));
}

/**
 * 受け取った ρ⁻ が「今見ているウォッチリスト」と同じ銘柄構成で測られたものかを判定する。
 * 違う構成の値をそのまま崖に入れると誤解を生むので、UI 側で注意を出すために使う。
 */
export function sameUniverse(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}
