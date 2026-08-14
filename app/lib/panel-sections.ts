// パネルID → 所属セクションの解決。M3（レジストリ化）の最小断片。
//
// なぜ要るか
// ----------
// 共有URLは `?sec=...` と `?panel=...` を独立に持つ。パネルIDから所属セクションを引く
// 手段が無かったため、両者が食い違うと `page.tsx` は 60フレーム DOM を探して
// **無言で諦める**（そのパネルはその節に存在しないので、何フレーム待っても現れない）。
// 節をまたぐ `openAnalysisPanel()` も同じ理由で黙って何も起きない。
// どちらも「壊れているように見えない壊れ方」なので、気づかれずに残っていた。
//
// 対応表の実体
// ------------
// 節とIDの対応は既にコード上の命名規約として存在する（`cal-*` はカレンダー節、
// `dist-*` は分布節、`sa-volatility-*` は旧アンカー形式のボラティリティ節）。
// この表はその規約を明文化しただけで、新しい対応を発明していない。
//
// 全IDを列挙しないのは `page.tsx` と二重管理になるため。前置だけを持ち、
// 規約から外れたIDが増えていないことは `__tests__/page-wiring.test.ts` が
// `app/page.tsx` を実際に読んで検査する。失敗したら、表とIDのどちらかを直すこと。
//
// M3（レジストリ化）が入ったら、この表は「IDの一覧を持つ本物のレジストリ」に
// 吸収されて消える。それまでの橋渡しである。

/**
 * パネルIDの先頭トークン → セクションキー。
 * 短縮形（`cal`）と旧アンカーの完全形（`sa-volatility-…` の `volatility`）の両方を持つ。
 */
const HEAD_TO_SECTION: Record<string, string> = {
  asof: "asof",
  basic: "basic",
  cal: "calendar",
  causal: "causal",
  cond: "conditional",
  deriv: "derivatives",
  dist: "distribution",
  distribution: "distribution",
  edge: "edge",
  ent: "entropy",
  entropy: "entropy",
  frac: "fractal",
  fractal: "fractal",
  freq: "frequency",
  frequency: "frequency",
  net: "network",
  network: "network",
  nl: "nonlinear",
  nonlinear: "nonlinear",
  ohlc: "ohlc",
  quantum: "quantum",
  regime: "regime",
  risk: "risk",
  sim: "simulation",
  tail: "tailrisk",
  tech: "technical",
  technical: "technical",
  transform: "transform",
  vol: "volatility",
  volatility: "volatility",
};

/**
 * 命名規約に乗らないID。個別に対応を書く。
 * `data-quality` は先頭が `data` で節名を含まない（破損点検パネルは基本節にある）。
 */
const EXPLICIT: Record<string, string> = {
  "data-quality": "basic",
};

/**
 * パネルIDから所属セクションキーを返す。解決できなければ `null`。
 *
 * `/portfolio` のパネル（`pf-*`）は別ページなので対象外＝`null` を返す。
 * 呼び出し側は `null` を「節を特定できないので現在の節のまま探す」として扱うこと
 * （従来と同じ挙動に落ちるだけで、新たに壊れる経路は無い）。
 */
export function sectionForPanel(panelId: string): string | null {
  if (!panelId) return null;
  const explicit = EXPLICIT[panelId];
  if (explicit) return explicit;

  // 旧アンカー形式 `sa-<節>-…` は先頭の `sa-` を落としてから解決する。
  const body = panelId.startsWith("sa-") ? panelId.slice(3) : panelId;
  const head = body.split("-")[0];
  return HEAD_TO_SECTION[head] ?? null;
}
