// 曜日 × 前夜米国：交互作用の解剖（日足・フル標本）
// =============================================================================
// null-anatomy.ts の④「前夜米国ビンで層別」は、米国で説明できる分を実測とヌルの
// 両方から同時に消して「米国を超えた曜日効果が残るか」を問う操作だった。
// 本モジュールはその真逆——「曜日効果の大きさが米国の状態に依存するか」を問う。
//
//   r = μ + α_d(曜日) + β_b(米国) + γ_{d,b}(交互作用) + ε
//
// β は既知で巨大（スピルオーバーそのもの、発見ではない）。α は cal-null-anatomy が
// 検定済み。未検証なのは γ だけであり、しかも γ には実在すべき制度的理由がある：
//
//   JP月曜の「前夜米国」＝米国*金曜*セッション。引け→寄りまで約62時間で、
//   間に土日の情報空白を含む。JP火〜金は単一セッションで約15時間。
//   つまり「前夜米国」という変数の定義自体が曜日によって違う。
//
// したがって β_gap,月 は他曜日より高いはず（48時間ぶんの情報が寄りにまとめて乗る）。
// では β_intra,月 は？——週末に溜まった情報が寄りで消化しきれず日中に漏れるなら正。
// これは反証可能な事前仮説であり、データマイニングではない。
//
// 設計上の要点:
//   ・ビンで切るのは連続量を3値に潰して検出力を捨てる行為。判定は連続回帰の
//     「曜日別スピルオーバーβの均一性」で行い、ビンのヒートマップは表示に留める。
//     （cal-null-calib で「累積リターンでなくFで判定する」としたのと同じ構図）
//   ・目的変数の選択が最重要。gap の曜日差は寄り付いた時点で既に起きており
//     取引不可能。建玉に変換できるのは intra（と夜間）の曜日差だけ。
//   ・帰無は「週内で (y,u) をペアのまま曜日ラベルごと置換」。ペアを壊さないので
//     共通βと u の周辺分布は保存され、曜日ラベルだけが壊れる。
//   ・ただし u の分布は曜日で違う（月曜は62時間ぶんで分散が大きい）。置換はこれを
//     均してしまい群ごとのレバレッジが変わるので、HC3ロバスト Wald（Cochran Q）を
//     必ず併走させ、両者が一致するかを見る。片方だけを信用してはいけない。
import { PricePoint } from "./types";

export const WD = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_MS = 86400000;

// =============================================================================
// 乱数・数値
// =============================================================================
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gammln(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// 正則化不完全ガンマ P(a,x)（級数＋連分数）
function gammp(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let i = 0; i < 400; i++) {
      ap++;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-13) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gammln(a));
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 400; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-13) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gammln(a)) * h;
}

export function chiSquareSurvival(x: number, k: number): number {
  if (!(x > 0) || k <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - gammp(k / 2, x / 2)));
}

// 標準正規の両側 p（Abramowitz-Stegun 7.1.26 による erf 近似）
export function normalTwoSidedP(z: number): number {
  if (!isFinite(z)) return 1;
  const a = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * a);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return Math.max(0, Math.min(1, 1 - erf));
}

function quantileSorted(a: number[], q: number): number {
  if (a.length === 0) return 0;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

// =============================================================================
// データ整形
// =============================================================================
export interface WuDay {
  date: string;
  dow: number; // 1=月..5=金
  week: number;
  u: number; // 前夜米国（当日の寄り前の最後の米国セッション）
  uNext: number; // 当夜米国（＝翌営業日の u）
  hasU: boolean;
  hasUNext: boolean;
  gap: number; // open/prevClose − 1
  intra: number; // close/open − 1
  full: number; // close/prevClose − 1
  over: number; // nextOpen/close − 1
  hasOver: boolean;
  postBreak: boolean; // 連休明け
  preBreak: boolean; // 連休前
  hours: number; // 前営業日引け→当日寄りの概算経過時間（gap/intra/full 用）
  hoursNext: number; // 当日引け→翌営業日寄りの概算経過時間（over 用）
}

export type Target = "intra" | "gap" | "full" | "over";
export const TARGETS: Target[] = ["intra", "over", "gap", "full"];

export const TARGET_META: Record<
  Target,
  { label: string; short: string; desc: string; tradable: boolean }
> = {
  intra: {
    label: "日中（寄→引）",
    short: "日中",
    desc: "米国の情報が寄りで消化しきれず日中に漏れ出す分。曜日差が出たとき、これだけが建玉に変換できる。ドライバは当日の前夜米国。",
    tradable: true,
  },
  over: {
    label: "オーバーナイト（引→翌寄）",
    short: "夜間",
    desc: "当夜の米国セッションの反映率そのもの。金曜のこれが週末ギャップ。cal-null-anatomy が検出した「木引→翌寄」の正体をここで分離できる。ドライバは当夜の米国。",
    tradable: true,
  },
  gap: {
    label: "寄りギャップ（前日引→寄）",
    short: "ギャップ",
    desc: "米国の織り込み度そのもの。曜日差が出ても寄り付いた時点で既に起きているため取引不可能。月曜がここで大きいのは62時間ぶんの情報が乗るからで、発見ではなく構造。",
    tradable: false,
  },
  full: {
    label: "当日（前日引→引）",
    short: "当日",
    desc: "ギャップ＋日中の総感応度。ギャップが支配的なので曜日差はギャップ由来になりがちで、単独では判断材料にならない。",
    tradable: false,
  },
};

export function buildWuDays(prices: PricePoint[], us: PricePoint[]): WuDay[] {
  const n = prices.length;
  if (n < 3 || us.length < 60) return [];

  const ut = us.map((p) => Date.parse(p.time));
  const uret: number[] = new Array(us.length).fill(NaN);
  for (let k = 1; k < us.length; k++) {
    if (us[k - 1].close > 0 && us[k].close > 0) uret[k] = us[k].close / us[k - 1].close - 1;
  }
  // JP 日付より厳密に前の、最後の米国セッションのリターン
  const prevUs = (jpTime: number): number => {
    let lo = 0;
    let hi = us.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ut[mid] < jpTime) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 1 && isFinite(uret[found]) ? uret[found] : NaN;
  };

  const t = prices.map((p) => Date.parse(p.time));
  const dow = prices.map((p) => new Date(p.time).getDay());

  // 週グループ（曜日が前日以下なら新しい週）。null-calibration と同一規則。
  const week: number[] = new Array(n);
  let w = -1;
  for (let i = 0; i < n; i++) {
    if (i === 0 || dow[i] <= dow[i - 1]) w++;
    week[i] = w;
  }

  const out: WuDay[] = [];
  for (let i = 1; i < n; i++) {
    if (dow[i] < 1 || dow[i] > 5) continue;
    const prevC = prices[i - 1].close;
    const o = prices[i].open;
    const c = prices[i].close;
    if (!(prevC > 0) || !(o > 0) || !(c > 0)) continue;

    const hasOver = i < n - 1 && prices[i + 1].open > 0;
    const normalPrev = dow[i] === 1 ? 3 : 1;
    const normalNext = dow[i] === 5 ? 3 : 1;
    const gapPrev = Math.round((t[i] - t[i - 1]) / DAY_MS);
    const gapNext = i < n - 1 ? Math.round((t[i + 1] - t[i]) / DAY_MS) : normalNext;
    const uThis = prevUs(t[i]);
    const uNext = i < n - 1 ? prevUs(t[i + 1]) : NaN;

    out.push({
      date: prices[i].time,
      dow: dow[i],
      week: week[i],
      u: uThis,
      uNext,
      hasU: isFinite(uThis),
      hasUNext: isFinite(uNext),
      gap: o / prevC - 1,
      intra: c / o - 1,
      full: c / prevC - 1,
      over: hasOver ? prices[i + 1].open / c - 1 : 0,
      hasOver,
      postBreak: gapPrev - normalPrev > 0,
      preBreak: gapNext - normalNext > 0,
      // 引け15:00 JST → 寄り9:00 JST を基準に、暦日ぶんを足した概算。
      // gap/intra/full は「前営業日引け→当日寄り」、over は「当日引け→翌営業日寄り」が
      // 対応する空白時間なので、両方を持たせて目的変数に応じて使い分ける。
      hours: gapPrev * 24 - 6,
      hoursNext: gapNext * 24 - 6,
    });
  }
  return out;
}

// 目的変数とドライバの取り出し。over だけは「当夜の米国」が対応する。
export function pick(d: WuDay, target: Target): { y: number; u: number; ok: boolean } {
  if (target === "over") return { y: d.over, u: d.uNext, ok: d.hasOver && d.hasUNext };
  const y = target === "intra" ? d.intra : target === "gap" ? d.gap : d.full;
  return { y, u: d.u, ok: d.hasU && isFinite(y) };
}

// =============================================================================
// 標本（型付き配列。置換ループで一切アロケートしないための構造）
// =============================================================================
interface Sample {
  n: number;
  y: Float64Array;
  u: Float64Array;
  up: Float64Array; // max(u,0)
  dn: Float64Array; // min(u,0)
  dow0: Int32Array; // 元の曜日 0..4
  bin: Int32Array;
  blocks: Int32Array[]; // 同一週で要素2以上のブロック
  nBins: number;
  binEdges: number[];
}

function makeSample(
  y: number[],
  u: number[],
  dow: number[],
  week: number[],
  nBins: number,
): Sample {
  const n = y.length;
  const s: Sample = {
    n,
    y: Float64Array.from(y),
    u: Float64Array.from(u),
    up: new Float64Array(n),
    dn: new Float64Array(n),
    dow0: Int32Array.from(dow.map((d) => d - 1)),
    bin: new Int32Array(n),
    blocks: [],
    nBins,
    binEdges: [],
  };
  for (let i = 0; i < n; i++) {
    s.up[i] = Math.max(0, u[i]);
    s.dn[i] = Math.min(0, u[i]);
  }
  const sorted = u.slice().sort((a, b) => a - b);
  for (let k = 1; k < nBins; k++) s.binEdges.push(quantileSorted(sorted, k / nBins));
  for (let i = 0; i < n; i++) {
    let b = 0;
    while (b < s.binEdges.length && u[i] > s.binEdges[b]) b++;
    s.bin[i] = b;
  }
  const map = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const a = map.get(week[i]);
    if (a) a.push(i);
    else map.set(week[i], [i]);
  }
  for (const arr of map.values()) if (arr.length >= 2) s.blocks.push(Int32Array.from(arr));
  return s;
}

// =============================================================================
// 曜日別回帰（HC3 標準誤差・閉形式・アロケートなし）
// =============================================================================
// 単回帰  y = a + b·u              → a_d, b_d
// 折れ線  y = a + b⁺·max(u,0) + b⁻·min(u,0)   → 上下非対称
//
// HC3: Var(β̂) = (X'X)⁻¹ [ Σ x_i x_i' e_i²/(1−h_i)² ] (X'X)⁻¹
// リターンのように分散が状態依存する系列では素の OLS 標準誤差は必ず過小になるので、
// 曜日間で β を比べる本分析では HC3 が最低限の要件になる。
interface FitOut {
  n: Float64Array; // 5
  alpha: Float64Array;
  alphaSe: Float64Array;
  beta: Float64Array;
  betaSe: Float64Array;
  up: Float64Array;
  upSe: Float64Array;
  dn: Float64Array;
  dnSe: Float64Array;
  sdU: Float64Array;
}

function newFitOut(): FitOut {
  const z = () => new Float64Array(5);
  return {
    n: z(),
    alpha: z(),
    alphaSe: z(),
    beta: z(),
    betaSe: z(),
    up: z(),
    upSe: z(),
    dn: z(),
    dnSe: z(),
    sdU: z(),
  };
}

// スクラッチ（呼び出し間で使い回す）
interface FitScratch {
  cnt: Float64Array;
  Su: Float64Array;
  Suu: Float64Array;
  Sy: Float64Array;
  Suy: Float64Array;
  Syy: Float64Array;
  P: Float64Array; // Σ up
  PP: Float64Array;
  Q: Float64Array; // Σ dn
  QQ: Float64Array;
  Py: Float64Array;
  Qy: Float64Array;
  nUp: Float64Array;
  nDn: Float64Array;
  // meat（2x2 と 3x3）
  m00: Float64Array;
  m01: Float64Array;
  m11: Float64Array;
  a00: Float64Array;
  a01: Float64Array;
  a02: Float64Array;
  a11: Float64Array;
  a22: Float64Array;
  // 係数と逆行列の一時保管
  bA: Float64Array;
  bB: Float64Array;
  i00: Float64Array;
  i01: Float64Array;
  i11: Float64Array;
  c0: Float64Array;
  c1: Float64Array;
  c2: Float64Array;
  j00: Float64Array;
  j01: Float64Array;
  j02: Float64Array;
  j11: Float64Array;
  j12: Float64Array;
  j22: Float64Array;
  ok3: Uint8Array;
}

function newFitScratch(): FitScratch {
  const z = () => new Float64Array(5);
  return {
    cnt: z(), Su: z(), Suu: z(), Sy: z(), Suy: z(), Syy: z(),
    P: z(), PP: z(), Q: z(), QQ: z(), Py: z(), Qy: z(), nUp: z(), nDn: z(),
    m00: z(), m01: z(), m11: z(),
    a00: z(), a01: z(), a02: z(), a11: z(), a22: z(),
    bA: z(), bB: z(), i00: z(), i01: z(), i11: z(),
    c0: z(), c1: z(), c2: z(), j00: z(), j01: z(), j02: z(), j11: z(), j12: z(), j22: z(),
    ok3: new Uint8Array(5),
  };
}

const MIN_DOW_N = 30;
const MIN_SIDE_N = 20;

function fitByDow(s: Sample, dow: Int32Array, sc: FitScratch, out: FitOut): void {
  // i11 / ok3 は「その曜日の当てはめが成立したか」のフラグとして後段で読むので、
  // 前回呼び出しの値が残らないよう必ずゼロ埋めしてから始める。
  const F = [
    sc.cnt, sc.Su, sc.Suu, sc.Sy, sc.Suy, sc.Syy, sc.P, sc.PP, sc.Q, sc.QQ, sc.Py, sc.Qy,
    sc.nUp, sc.nDn, sc.m00, sc.m01, sc.m11, sc.a00, sc.a01, sc.a02, sc.a11, sc.a22,
    sc.bA, sc.bB, sc.i00, sc.i01, sc.i11,
  ];
  for (const arr of F) arr.fill(0);
  out.sdU.fill(0);
  out.alpha.fill(NaN);
  out.alphaSe.fill(NaN);
  out.beta.fill(NaN);
  out.betaSe.fill(NaN);
  out.up.fill(NaN);
  out.upSe.fill(NaN);
  out.dn.fill(NaN);
  out.dnSe.fill(NaN);
  sc.ok3.fill(0);

  // --- パス1: 十分統計量 ---
  for (let i = 0; i < s.n; i++) {
    const d = dow[i];
    const yi = s.y[i];
    const ui = s.u[i];
    const pi = s.up[i];
    const qi = s.dn[i];
    sc.cnt[d]++;
    sc.Su[d] += ui;
    sc.Suu[d] += ui * ui;
    sc.Sy[d] += yi;
    sc.Suy[d] += ui * yi;
    sc.Syy[d] += yi * yi;
    sc.P[d] += pi;
    sc.PP[d] += pi * pi;
    sc.Q[d] += qi;
    sc.QQ[d] += qi * qi;
    sc.Py[d] += pi * yi;
    sc.Qy[d] += qi * yi;
    if (ui > 0) sc.nUp[d]++;
    else if (ui < 0) sc.nDn[d]++;
  }

  for (let d = 0; d < 5; d++) {
    const nd = sc.cnt[d];
    out.n[d] = nd;
    if (nd < MIN_DOW_N) continue;
    const ubar = sc.Su[d] / nd;
    const sxx = sc.Suu[d] - nd * ubar * ubar;
    out.sdU[d] = nd > 1 ? Math.sqrt(Math.max(0, sxx / (nd - 1))) : 0;
    if (!(sxx > 0)) continue;
    const sxy = sc.Suy[d] - ubar * sc.Sy[d];
    const b = sxy / sxx;
    const a = sc.Sy[d] / nd - b * ubar;
    sc.bA[d] = a;
    sc.bB[d] = b;
    // (X'X)⁻¹ for X=[1,u]:  det = n·sxx
    const det = nd * sxx;
    sc.i00[d] = sc.Suu[d] / det;
    sc.i01[d] = -sc.Su[d] / det;
    sc.i11[d] = nd / det;

    // 3列モデル: X=[1, up, dn]（up·dn ≡ 0 なので X'X は疎）
    if (sc.nUp[d] >= MIN_SIDE_N && sc.nDn[d] >= MIN_SIDE_N && sc.PP[d] > 0 && sc.QQ[d] > 0) {
      const N = nd;
      const P = sc.P[d];
      const PP = sc.PP[d];
      const Q = sc.Q[d];
      const QQ = sc.QQ[d];
      const det3 = N * PP * QQ - P * P * QQ - Q * Q * PP;
      if (Math.abs(det3) > 1e-24) {
        sc.j00[d] = (PP * QQ) / det3;
        sc.j01[d] = (-P * QQ) / det3;
        sc.j02[d] = (-Q * PP) / det3;
        sc.j11[d] = (N * QQ - Q * Q) / det3;
        sc.j12[d] = (P * Q) / det3;
        sc.j22[d] = (N * PP - P * P) / det3;
        const y0 = sc.Sy[d];
        const y1 = sc.Py[d];
        const y2 = sc.Qy[d];
        sc.c0[d] = sc.j00[d] * y0 + sc.j01[d] * y1 + sc.j02[d] * y2;
        sc.c1[d] = sc.j01[d] * y0 + sc.j11[d] * y1 + sc.j12[d] * y2;
        sc.c2[d] = sc.j02[d] * y0 + sc.j12[d] * y1 + sc.j22[d] * y2;
        sc.ok3[d] = 1;
      }
    }
  }

  // --- パス2: 残差・レバレッジ・HC3 のサンドイッチ中央項 ---
  for (let i = 0; i < s.n; i++) {
    const d = dow[i];
    if (sc.cnt[d] < MIN_DOW_N) continue;
    const ui = s.u[i];
    const yi = s.y[i];
    if (sc.i11[d] !== 0) {
      const e = yi - sc.bA[d] - sc.bB[d] * ui;
      const h = sc.i00[d] + 2 * sc.i01[d] * ui + sc.i11[d] * ui * ui;
      const w = (e * e) / Math.max(1e-12, (1 - Math.min(0.9995, h)) ** 2);
      sc.m00[d] += w;
      sc.m01[d] += w * ui;
      sc.m11[d] += w * ui * ui;
    }
    if (sc.ok3[d]) {
      const pi = s.up[i];
      const qi = s.dn[i];
      const e = yi - sc.c0[d] - sc.c1[d] * pi - sc.c2[d] * qi;
      const h =
        sc.j00[d] +
        2 * sc.j01[d] * pi +
        2 * sc.j02[d] * qi +
        sc.j11[d] * pi * pi +
        sc.j22[d] * qi * qi; // 交差項 2·j12·p·q は p·q≡0 なので消える
      const w = (e * e) / Math.max(1e-12, (1 - Math.min(0.9995, h)) ** 2);
      sc.a00[d] += w;
      sc.a01[d] += w * pi;
      sc.a02[d] += w * qi;
      sc.a11[d] += w * pi * pi;
      sc.a22[d] += w * qi * qi;
    }
  }

  for (let d = 0; d < 5; d++) {
    if (sc.cnt[d] < MIN_DOW_N || sc.i11[d] === 0) continue;
    const i00 = sc.i00[d];
    const i01 = sc.i01[d];
    const i11 = sc.i11[d];
    const M00 = sc.m00[d];
    const M01 = sc.m01[d];
    const M11 = sc.m11[d];
    const varA = i00 * i00 * M00 + 2 * i00 * i01 * M01 + i01 * i01 * M11;
    const varB = i01 * i01 * M00 + 2 * i01 * i11 * M01 + i11 * i11 * M11;
    out.alpha[d] = sc.bA[d];
    out.alphaSe[d] = Math.sqrt(Math.max(0, varA));
    out.beta[d] = sc.bB[d];
    out.betaSe[d] = Math.sqrt(Math.max(0, varB));

    if (sc.ok3[d]) {
      const j01 = sc.j01[d];
      const j02 = sc.j02[d];
      const j11 = sc.j11[d];
      const j12 = sc.j12[d];
      const j22 = sc.j22[d];
      const A00 = sc.a00[d];
      const A01 = sc.a01[d];
      const A02 = sc.a02[d];
      const A11 = sc.a11[d];
      const A22 = sc.a22[d];
      // Var(c1) = r·M·r' で r = (j01, j11, j12)、M の (1,2)成分は Σw·p·q = 0
      const r0 = j01;
      const r1 = j11;
      const r2 = j12;
      const v1 =
        r0 * r0 * A00 + r1 * r1 * A11 + r2 * r2 * A22 + 2 * r0 * r1 * A01 + 2 * r0 * r2 * A02;
      const s0 = j02;
      const s1 = j12;
      const s2 = j22;
      const v2 =
        s0 * s0 * A00 + s1 * s1 * A11 + s2 * s2 * A22 + 2 * s0 * s1 * A01 + 2 * s0 * s2 * A02;
      out.up[d] = sc.c1[d];
      out.upSe[d] = Math.sqrt(Math.max(0, v1));
      out.dn[d] = sc.c2[d];
      out.dnSe[d] = Math.sqrt(Math.max(0, v2));
    }
  }
}

// =============================================================================
// 係数の均一性（Cochran の Q）
// =============================================================================
// 5曜日の回帰は互いに素な標本の上で走るので係数は独立。したがって
//   Q = Σ w_d (b_d − b̄_w)²,  w_d = 1/se_d²,  b̄_w = Σ w_d b_d / Σ w_d
// が χ²(k−1) に従う。I² は「群間のばらつきのうち偶然では説明できない割合」。
export interface HomogeneityTest {
  q: number;
  df: number;
  pWald: number;
  pPerm: number;
  i2: number;
  pooled: number;
  pooledSe: number;
}

function qStat(b: Float64Array, se: Float64Array): { q: number; df: number; pooled: number; pooledSe: number; i2: number } {
  let sw = 0;
  let swb = 0;
  let cnt = 0;
  for (let i = 0; i < b.length; i++) {
    if (!(se[i] > 0) || !isFinite(b[i])) continue;
    const w = 1 / (se[i] * se[i]);
    sw += w;
    swb += w * b[i];
    cnt++;
  }
  if (cnt < 2 || !(sw > 0)) return { q: 0, df: 0, pooled: 0, pooledSe: 0, i2: 0 };
  const pooled = swb / sw;
  let q = 0;
  for (let i = 0; i < b.length; i++) {
    if (!(se[i] > 0) || !isFinite(b[i])) continue;
    q += (b[i] - pooled) ** 2 / (se[i] * se[i]);
  }
  const df = cnt - 1;
  return { q, df, pooled, pooledSe: Math.sqrt(1 / sw), i2: q > df ? (q - df) / q : 0 };
}

// =============================================================================
// セル（曜日 × 米国ビン）
// =============================================================================
// γ̂_{d,b} = μ̂_{d,b} − mean_b(μ̂_{d,·}) − mean_d(μ̂_{·,b}) + mean(μ̂)
// セル平均の「非加重」平均で中心化するので、セル数の偏りに関わらず加法効果
// （α_d と β_b）に厳密に直交する。したがって置換が α を壊すことは問題にならない。
interface CellScratch {
  sum: Float64Array;
  sq: Float64Array;
  cnt: Float64Array;
  mean: Float64Array;
  sd: Float64Array;
  delta: Float64Array;
  gamma: Float64Array;
  t: Float64Array;
  binSum: Float64Array;
  binCnt: Float64Array;
  binMean: Float64Array;
  rowM: Float64Array;
  rowC: Float64Array;
  colM: Float64Array;
  colC: Float64Array;
  fInt: number;
}

function newCellScratch(nBins: number): CellScratch {
  const K = 5 * nBins;
  return {
    sum: new Float64Array(K),
    sq: new Float64Array(K),
    cnt: new Float64Array(K),
    mean: new Float64Array(K),
    sd: new Float64Array(K),
    delta: new Float64Array(K),
    gamma: new Float64Array(K),
    t: new Float64Array(K),
    binSum: new Float64Array(nBins),
    binCnt: new Float64Array(nBins),
    binMean: new Float64Array(nBins),
    rowM: new Float64Array(5),
    rowC: new Float64Array(5),
    colM: new Float64Array(nBins),
    colC: new Float64Array(nBins),
    fInt: 0,
  };
}

function cellCalc(s: Sample, dow: Int32Array, cs: CellScratch): void {
  const nBins = s.nBins;
  const K = 5 * nBins;
  cs.sum.fill(0);
  cs.sq.fill(0);
  cs.cnt.fill(0);
  cs.binSum.fill(0);
  cs.binCnt.fill(0);
  cs.rowM.fill(0);
  cs.rowC.fill(0);
  cs.colM.fill(0);
  cs.colC.fill(0);

  for (let i = 0; i < s.n; i++) {
    const b = s.bin[i];
    const k = dow[i] * nBins + b;
    const yi = s.y[i];
    cs.sum[k] += yi;
    cs.sq[k] += yi * yi;
    cs.cnt[k]++;
    cs.binSum[b] += yi;
    cs.binCnt[b]++;
  }
  for (let b = 0; b < nBins; b++) cs.binMean[b] = cs.binCnt[b] > 0 ? cs.binSum[b] / cs.binCnt[b] : 0;

  let allM = 0;
  let allC = 0;
  for (let k = 0; k < K; k++) {
    if (cs.cnt[k] === 0) {
      cs.mean[k] = 0;
      cs.sd[k] = 0;
      continue;
    }
    const m = cs.sum[k] / cs.cnt[k];
    cs.mean[k] = m;
    cs.sd[k] =
      cs.cnt[k] > 1 ? Math.sqrt(Math.max(0, (cs.sq[k] - cs.cnt[k] * m * m) / (cs.cnt[k] - 1))) : 0;
    const d = (k / nBins) | 0;
    const b = k % nBins;
    cs.rowM[d] += m;
    cs.rowC[d]++;
    cs.colM[b] += m;
    cs.colC[b]++;
    allM += m;
    allC++;
  }
  for (let d = 0; d < 5; d++) if (cs.rowC[d]) cs.rowM[d] /= cs.rowC[d];
  for (let b = 0; b < nBins; b++) if (cs.colC[b]) cs.colM[b] /= cs.colC[b];
  if (allC) allM /= allC;

  let ssInt = 0;
  let ssw = 0;
  let nTot = 0;
  let nCell = 0;
  for (let k = 0; k < K; k++) {
    if (cs.cnt[k] === 0) {
      cs.gamma[k] = 0;
      cs.delta[k] = 0;
      cs.t[k] = 0;
      continue;
    }
    const d = (k / nBins) | 0;
    const b = k % nBins;
    cs.gamma[k] = cs.mean[k] - cs.rowM[d] - cs.colM[b] + allM;
    cs.delta[k] = cs.mean[k] - cs.binMean[b];
    const se = cs.sd[k] / Math.sqrt(cs.cnt[k]);
    cs.t[k] = se > 0 ? cs.delta[k] / se : 0;
    ssInt += cs.cnt[k] * cs.gamma[k] * cs.gamma[k];
    ssw += (cs.cnt[k] - 1) * cs.sd[k] * cs.sd[k];
    nTot += cs.cnt[k];
    nCell++;
  }
  const dfInt = Math.max(1, (5 - 1) * (nBins - 1));
  const dfw = Math.max(1, nTot - nCell);
  cs.fInt = ssw > 0 ? ssInt / dfInt / (ssw / dfw) : 0;
}

// =============================================================================
// 結果型
// =============================================================================
export type SampleFilter = "all" | "exBreak" | "firstHalf" | "secondHalf";

export const FILTER_LABEL: Record<SampleFilter, string> = {
  all: "全標本",
  exBreak: "連休明け／連休前を除外",
  firstHalf: "期間の前半のみ",
  secondHalf: "期間の後半のみ",
};

export const FILTER_WHY: Record<SampleFilter, string> = {
  all: "基準。",
  exBreak:
    "連休は「前夜米国が複数セッションぶん」になる月曜の構造を拡大したもの。これを除いてもβ差が残るかを見る。",
  firstHalf: "時代分割。βの曜日差が過去にしか無いなら、いま資金を置く根拠にならない。",
  secondHalf: "時代分割。前半と後半で符号が反転していないかを見る。",
};

export interface DowBeta {
  dow: number;
  label: string;
  n: number;
  alpha: number;
  alphaSe: number;
  beta: number;
  betaSe: number;
  betaLo: number;
  betaHi: number;
  sdU: number;
  meanHours: number;
  impact: number; // β × sdU ＝ 1σ の米国変動あたりの実効インパクト
  betaUp: number;
  betaUpSe: number;
  betaDn: number;
  betaDnSe: number;
  asymZ: number;
  asymP: number;
}

export interface Cell {
  dow: number;
  bin: number;
  n: number;
  mean: number;
  sd: number;
  delta: number;
  gamma: number;
  t: number;
  pRaw: number;
  pAdj: number;
}

export interface WuOne {
  filter: SampleFilter;
  n: number;
  dows: DowBeta[];
  homBeta: HomogeneityTest;
  homBetaUp: HomogeneityTest;
  homBetaDn: HomogeneityTest;
  homAlpha: HomogeneityTest;
  cells: Cell[];
  binEdges: number[];
  binMeans: number[];
  fInt: number;
  fIntP: number;
  fInt95: number;
  tCritFwer: number;
  tCritSingle: number;
}

export interface WuParams {
  target: Target;
  nBins: number;
  nIter: number;
  seed: number;
  costBps: number;
}

export const DEFAULT_WU_PARAMS: WuParams = {
  target: "intra",
  nBins: 3,
  nIter: 1000,
  seed: 20260726,
  costBps: 10,
};

export interface WuResult {
  ok: boolean;
  reason?: string;
  main: WuOne | null;
  robust: WuOne[];
  params: WuParams;
  nDays: number;
  nWeeks: number;
  splitDate: string;
  hoursByDow: number[]; // 1..5 の平均経過時間
}

export function emptyWu(params: WuParams, reason: string): WuResult {
  return {
    ok: false,
    reason,
    main: null,
    robust: [],
    params,
    nDays: 0,
    nWeeks: 0,
    splitDate: "",
    hoursByDow: [],
  };
}

// =============================================================================
// 1標本ぶんの全計算
// =============================================================================
function computeOne(
  y: number[],
  u: number[],
  dow: number[],
  week: number[],
  filter: SampleFilter,
  params: WuParams,
  onIter?: () => void,
): WuOne | null {
  if (y.length < 150) return null;
  const s = makeSample(y, u, dow, week, params.nBins);
  const sc = newFitScratch();
  const fit = newFitOut();
  const cs = newCellScratch(params.nBins);
  const K = 5 * params.nBins;

  fitByDow(s, s.dow0, sc, fit);
  let usable = 0;
  for (let d = 0; d < 5; d++) if (fit.n[d] >= MIN_DOW_N) usable++;
  if (usable < 4) return null;

  const homB = qStat(fit.beta, fit.betaSe);
  const homU = qStat(fit.up, fit.upSe);
  const homD = qStat(fit.dn, fit.dnSe);
  const homA = qStat(fit.alpha, fit.alphaSe);

  cellCalc(s, s.dow0, cs);
  const obsT = Float64Array.from(cs.t);
  const obsCnt = Float64Array.from(cs.cnt);
  const obsMean = Float64Array.from(cs.mean);
  const obsSd = Float64Array.from(cs.sd);
  const obsDelta = Float64Array.from(cs.delta);
  const obsGamma = Float64Array.from(cs.gamma);
  const obsF = cs.fInt;
  const binMeans = Array.from(cs.binMean);

  // ---- 置換: 週内で曜日ラベルだけを入れ替える ----
  const rnd = mulberry32(params.seed + filter.length * 104729);
  const permDow = Int32Array.from(s.dow0);
  const nIter = params.nIter;
  const tNull = new Float64Array(nIter * K);
  const qNull: number[] = [];
  const qUpNull: number[] = [];
  const qDnNull: number[] = [];
  const qAlNull: number[] = [];
  const fNull: number[] = [];
  const buf = new Int32Array(16);

  for (let it = 0; it < nIter; it++) {
    permDow.set(s.dow0);
    for (const b of s.blocks) {
      const m = b.length;
      const arr = m <= buf.length ? buf : new Int32Array(m);
      for (let i = 0; i < m; i++) arr[i] = s.dow0[b[i]];
      for (let i = m - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      for (let i = 0; i < m; i++) permDow[b[i]] = arr[i];
    }
    fitByDow(s, permDow, sc, fit);
    qNull.push(qStat(fit.beta, fit.betaSe).q);
    qUpNull.push(qStat(fit.up, fit.upSe).q);
    qDnNull.push(qStat(fit.dn, fit.dnSe).q);
    qAlNull.push(qStat(fit.alpha, fit.alphaSe).q);
    cellCalc(s, permDow, cs);
    fNull.push(cs.fInt);
    tNull.set(cs.t, it * K);
    onIter?.();
  }

  const pOf = (nulls: number[], v: number) => {
    let ge = 0;
    for (const x of nulls) if (x >= v - 1e-15) ge++;
    return (ge + 1) / (nulls.length + 1);
  };

  // ---- セル別 maxT step-down（セル全体で FWER）----
  const live: number[] = [];
  for (let k = 0; k < K; k++) if (obsCnt[k] >= 10) live.push(k);
  const pRaw = new Array(K).fill(1);
  const pAdj = new Array(K).fill(1);
  const p95: number[] = new Array(K).fill(0);
  const col: number[] = new Array(nIter);
  for (const k of live) {
    let ge = 0;
    for (let it = 0; it < nIter; it++) {
      const v = Math.abs(tNull[it * K + k]);
      col[it] = v;
      if (v >= Math.abs(obsT[k]) - 1e-15) ge++;
    }
    pRaw[k] = (ge + 1) / (nIter + 1);
    const sortedCol = col.slice().sort((a, b) => a - b);
    p95[k] = quantileSorted(sortedCol, 0.95);
  }
  const order = live.slice().sort((a, b) => Math.abs(obsT[b]) - Math.abs(obsT[a]));
  {
    const running = new Float64Array(nIter);
    const counts = new Array(order.length).fill(0);
    for (let idx = order.length - 1; idx >= 0; idx--) {
      const k = order[idx];
      for (let it = 0; it < nIter; it++) {
        const v = Math.abs(tNull[it * K + k]);
        if (v > running[it]) running[it] = v;
        if (running[it] >= Math.abs(obsT[k]) - 1e-15) counts[idx]++;
      }
    }
    let prev = 0;
    for (let idx = 0; idx < order.length; idx++) {
      const p = (counts[idx] + 1) / (nIter + 1);
      prev = Math.max(prev, p);
      pAdj[order[idx]] = prev;
    }
  }
  const maxes: number[] = new Array(nIter);
  for (let it = 0; it < nIter; it++) {
    let m = 0;
    for (const k of live) {
      const v = Math.abs(tNull[it * K + k]);
      if (v > m) m = v;
    }
    maxes[it] = m;
  }
  maxes.sort((a, b) => a - b);
  const singles = live
    .map((k) => p95[k])
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  // 実測の係数をもう一度（置換ループで fit を潰したため）
  fitByDow(s, s.dow0, sc, fit);
  const dows: DowBeta[] = [];
  for (let d = 0; d < 5; d++) {
    dows.push({
      dow: d + 1,
      label: WD[d + 1],
      n: fit.n[d],
      alpha: fit.alpha[d],
      alphaSe: fit.alphaSe[d],
      beta: fit.beta[d],
      betaSe: fit.betaSe[d],
      betaLo: fit.beta[d] - 1.96 * fit.betaSe[d],
      betaHi: fit.beta[d] + 1.96 * fit.betaSe[d],
      sdU: fit.sdU[d],
      meanHours: 0,
      impact: fit.beta[d] * fit.sdU[d],
      betaUp: fit.up[d],
      betaUpSe: fit.upSe[d],
      betaDn: fit.dn[d],
      betaDnSe: fit.dnSe[d],
      asymZ:
        fit.upSe[d] > 0 && fit.dnSe[d] > 0
          ? (fit.up[d] - fit.dn[d]) / Math.sqrt(fit.upSe[d] ** 2 + fit.dnSe[d] ** 2)
          : NaN,
      asymP:
        fit.upSe[d] > 0 && fit.dnSe[d] > 0
          ? normalTwoSidedP(
              (fit.up[d] - fit.dn[d]) / Math.sqrt(fit.upSe[d] ** 2 + fit.dnSe[d] ** 2),
            )
          : 1,
    });
  }

  const cells: Cell[] = [];
  for (let d = 0; d < 5; d++) {
    for (let b = 0; b < params.nBins; b++) {
      const k = d * params.nBins + b;
      cells.push({
        dow: d + 1,
        bin: b,
        n: obsCnt[k],
        mean: obsMean[k],
        sd: obsSd[k],
        delta: obsDelta[k],
        gamma: obsGamma[k],
        t: obsT[k],
        pRaw: pRaw[k],
        pAdj: pAdj[k],
      });
    }
  }

  const sortedF = fNull.slice().sort((a, b) => a - b);
  const wrap = (h: ReturnType<typeof qStat>, nulls: number[]): HomogeneityTest => ({
    ...h,
    pWald: chiSquareSurvival(h.q, h.df),
    pPerm: pOf(nulls, h.q),
  });

  return {
    filter,
    n: s.n,
    dows,
    homBeta: wrap(homB, qNull),
    homBetaUp: wrap(homU, qUpNull),
    homBetaDn: wrap(homD, qDnNull),
    homAlpha: wrap(homA, qAlNull),
    cells,
    binEdges: s.binEdges,
    binMeans,
    fInt: obsF,
    fIntP: pOf(fNull, obsF),
    fInt95: quantileSorted(sortedF, 0.95),
    tCritFwer: quantileSorted(maxes, 0.95),
    tCritSingle: singles.length ? quantileSorted(singles, 0.5) : 0,
  };
}

// =============================================================================
// エントリポイント
// =============================================================================
export function runWeekdayUs(
  prices: PricePoint[],
  us: PricePoint[] | null,
  params: WuParams,
  onProgress?: (done: number, total: number) => void,
): WuResult {
  if (!us || us.length < 60) return emptyWu(params, "米国指数のデータが取得できていません");
  const days = buildWuDays(prices, us);
  if (days.length < 250) return emptyWu(params, `標本が不足（${days.length}日。250日以上必要）`);

  const y: number[] = [];
  const u: number[] = [];
  const dw: number[] = [];
  const wk: number[] = [];
  const keep: WuDay[] = [];
  for (const d of days) {
    const p = pick(d, params.target);
    if (!p.ok || !isFinite(p.y) || !isFinite(p.u)) continue;
    y.push(p.y);
    u.push(p.u);
    dw.push(d.dow);
    wk.push(d.week);
    keep.push(d);
  }
  if (y.length < 250) return emptyWu(params, `有効標本が不足（${y.length}日）`);

  const sub = (mask: (d: WuDay, j: number) => boolean) => {
    const yy: number[] = [];
    const uu: number[] = [];
    const dd: number[] = [];
    const ww: number[] = [];
    for (let j = 0; j < keep.length; j++) {
      if (!mask(keep[j], j)) continue;
      yy.push(y[j]);
      uu.push(u[j]);
      dd.push(dw[j]);
      ww.push(wk[j]);
    }
    return { yy, uu, dd, ww };
  };

  const half = Math.floor(keep.length / 2);
  const splitDate = keep[Math.min(half, keep.length - 1)]?.date ?? "";

  const total = params.nIter * 4;
  let done = 0;
  const tick = () => {
    done++;
    if (onProgress && (done % 100 === 0 || done === total)) onProgress(done, total);
  };

  const main = computeOne(y, u, dw, wk, "all", params, tick);
  if (!main) return emptyWu(params, "曜日ごとの標本が回帰に足りません");

  const robust: WuOne[] = [];
  const a = sub((d) => !d.postBreak && !d.preBreak);
  const r1 = computeOne(a.yy, a.uu, a.dd, a.ww, "exBreak", params, tick);
  if (r1) robust.push(r1);
  const b = sub((_, j) => j < half);
  const r2 = computeOne(b.yy, b.uu, b.dd, b.ww, "firstHalf", params, tick);
  if (r2) robust.push(r2);
  const c = sub((_, j) => j >= half);
  const r3 = computeOne(c.yy, c.uu, c.dd, c.ww, "secondHalf", params, tick);
  if (r3) robust.push(r3);

  // 曜日別の平均「情報空白時間」（62時間 vs 15時間の構造をデータで見せる）。
  // over のときは当日引け→翌営業日寄りが対応区間なので、金曜が週末ぶんの長い枠になる。
  const useNext = params.target === "over";
  const hSum = new Array(6).fill(0);
  const hCnt = new Array(6).fill(0);
  for (const d of days) {
    hSum[d.dow] += useNext ? d.hoursNext : d.hours;
    hCnt[d.dow]++;
  }
  const hoursByDow = new Array(6).fill(0);
  for (let d = 1; d <= 5; d++) hoursByDow[d] = hCnt[d] ? hSum[d] / hCnt[d] : 0;
  for (const db of main.dows) db.meanHours = hoursByDow[db.dow];

  const weekSet = new Set(days.map((d) => d.week));
  return {
    ok: true,
    main,
    robust,
    params,
    nDays: days.length,
    nWeeks: weekSet.size,
    splitDate,
    hoursByDow,
  };
}
