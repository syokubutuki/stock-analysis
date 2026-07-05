// レジーム(相場基調) × 前夜米国 の交互作用: 日内平均累積パス。
//
// 「前夜米国が翌日にどう波及するか」を、そのときの“相場基調”で条件付けて見る。
// 基調は「可変累積トレンド」= 直近K営業日の累積対数リターンで定義し(K・閾値ともに可変)、
// 上昇基調/中立/下落基調(または銘柄×米国の一致・背反)に日を層別する。各バケツの中で
// 前夜米国リターンのビン(陰陽/3分位)別に寄り基準の日内累積パスを描き、米国スピルオーバーの
// 強さ・形が基調で変わるか(moderation / 交互作用)を可視化する。
//
// 基調ソースは3通り:
//   jp      … 対象銘柄自身の累積トレンド(外部要因に対し内生。モメンタム/平均回帰的)
//   us      … 米国指数の累積トレンド(対象銘柄に外生。押し目か continuation かの文脈)
//   concord … 銘柄と米国のトレンドの一致/背反(両方を1軸に畳んで同時利用)
//
// 先読み排除: 基調トレンドは「当日を含めない過去K日」で算出するため、寄り前に確定=実運用可。
// 特に us ソースでは「基調(過去K日の米国)」と「前夜米国(直近1日=ビン軸)」を厳密に分離し、
// トレンドの窓から前夜当日を除くことで両者の重複(共線性)を避ける。

import {
  AlignedDay, UsReturn, dayCumPath, assignBins, binMeta, binEdges, binOfValue, BinScheme,
} from "./us-spillover-core";
import { BinGrid } from "./intraday-core";
import {
  PathGroup, PathStat, PairDiff, buildPathStats, pairwiseEndDiffs,
} from "./intraday-path-core";

export type RegimeSource = "jp" | "us" | "concord";

// バケツ内の1つ = 前夜米国ビン別のパス集合 + その基調バケツの要約。
export interface RegimeBucket {
  key: string;
  label: string;
  color: string;
  n: number; // このバケツに属する立会日数
  usStats: PathStat[]; // 前夜米国ビン別の日内パス統計(平均/中央値/95%帯/ピーク時刻/終端)
  usPairDiffs: PairDiff[]; // 同バケツ内の米国ビン間 終端差(Welch t + FDR)
  spilloverSpread: number; // 米国最上位ビン − 最下位ビン の寄り→引け平均差(=スピルオーバー強度)
  spreadP: number; // その差の生p値
  spreadPAdj: number; // FDR補正後p値
}

export interface RegimeUsPathResult {
  source: RegimeSource;
  K: number;
  thresholdPct: number;
  usScheme: BinScheme;
  usBinLabels: string[];
  usBinColors: string[];
  usBinEdges: number[]; // 前夜米国ビンの境界値(長さ=count-1)。範囲表示・所属判定に使う。
  buckets: RegimeBucket[]; // 基調バケツ(固定順)
  timeLabels: string[];
  maxAbs: number; // 全バケツ共通の縦軸スケール
  days: { date: string; close: number; regimeKey: string }[]; // 原系列タイムライン用(日付昇順)
  // 直近の前夜米国(=ビン軸の実測値)。次セッションがどのビンに入るかを寄り前に判定する。
  latestUs: {
    date: string; // 対応する米国立会日
    value: number; // ln(close/prevClose) 前日終値比
    bin: number; // 所属する前夜米国ビン
    unpaired: boolean; // まだJP立会日とペアになっていない最新米国セッションか(寄り前・未反映)
    percentile: number; // 全標本中の順位(下から, 0..1)
  } | null;
  today: {
    jpTrend: number | null; // 直近K日(最新の確定日まで含む)の銘柄累積トレンド
    usTrend: number | null; // 同 米国累積トレンド
    regimeKey: string;
    label: string;
  } | null;
}

// トレンド値 → 3値(1=上昇, 0=中立, -1=下落)。
function trendSign(v: number, T: number): number {
  if (v >= T) return 1;
  if (v <= -T) return -1;
  return 0;
}

// 基調ソース別のバケツ定義(キー/ラベル/色)。concord は銘柄×米国の一致/背反で5分類。
const JP_BUCKETS = [
  { key: "up", label: "上昇基調", color: "#16a34a" },
  { key: "flat", label: "中立", color: "#9ca3af" },
  { key: "down", label: "下落基調", color: "#dc2626" },
];
const US_BUCKETS = [
  { key: "up", label: "米国上昇基調", color: "#16a34a" },
  { key: "flat", label: "米国中立", color: "#9ca3af" },
  { key: "down", label: "米国下落基調", color: "#dc2626" },
];
const CONCORD_BUCKETS = [
  { key: "bull", label: "順行・強気（自↑米↑）", color: "#16a34a" },
  { key: "divA", label: "背反・自強米弱（自↑米↓）", color: "#f59e0b" },
  { key: "divB", label: "背反・自弱米強（自↓米↑）", color: "#7c3aed" },
  { key: "bear", label: "順行・弱気（自↓米↓）", color: "#dc2626" },
  { key: "mid", label: "中立混在", color: "#9ca3af" },
];

function bucketDefs(source: RegimeSource) {
  if (source === "jp") return JP_BUCKETS;
  if (source === "us") return US_BUCKETS;
  return CONCORD_BUCKETS;
}

// 単一ソース(jp/us)のトレンド符号 → バケツキー。
function singleKey(sign: number): string {
  return sign > 0 ? "up" : sign < 0 ? "down" : "flat";
}

// concord: 銘柄・米国のトレンド符号 → バケツキー。
function concordKey(jpSign: number, usSign: number): string {
  if (jpSign > 0 && usSign > 0) return "bull";
  if (jpSign < 0 && usSign < 0) return "bear";
  if (jpSign > 0 && usSign < 0) return "divA";
  if (jpSign < 0 && usSign > 0) return "divB";
  return "mid";
}

export function computeRegimeUsPaths(
  aligned: AlignedDay[],
  us: UsReturn[],
  grid: BinGrid | null,
  gmtoffset: number,
  opts: { source: RegimeSource; K: number; thresholdPct: number; usScheme: BinScheme },
): RegimeUsPathResult | null {
  const { source, K, thresholdPct, usScheme } = opts;
  if (!grid || K < 1) return null;
  const T = thresholdPct / 100; // 対数リターン単位のしきい値

  // 前夜米国リターン(=ビン軸)。有効値のみ、日付昇順。
  const rows = [...aligned]
    .filter((a) => isFinite(a.us.ret) && isFinite(a.full))
    .sort((p, q) => p.jp.date.localeCompare(q.jp.date));
  if (rows.length < K + 8) return null;
  const G = grid.bins.length;

  // ── 銘柄自身の累積トレンド: 各日の直近K日(当日を含めない)の日次対数リターン合計 ──
  // AlignedDay.full = ln(close/prevClose) が日次対数リターン。前方K本の和が trailing 累積。
  const jpRet = rows.map((a) => a.full);
  const jpTrend = rows.map((_, i) => {
    if (i < K) return NaN;
    let s = 0;
    for (let k = 1; k <= K; k++) s += jpRet[i - k];
    return s;
  });

  // ── 米国の累積トレンド: 前夜米国日より前のK本のリターン合計(前夜当日=ビン軸は除外) ──
  const usSorted = [...us].filter((u) => isFinite(u.ret)).sort((a, b) => a.date.localeCompare(b.date));
  const usIdx = new Map<string, number>();
  usSorted.forEach((u, i) => usIdx.set(u.date, i));
  const usTrend = rows.map((a) => {
    const j = usIdx.get(a.us.date);
    if (j === undefined || j < K) return NaN;
    let s = 0;
    for (let k = 1; k <= K; k++) s += usSorted[j - k].ret;
    return s;
  });

  // ── 各日をバケツへ割り当て ──
  const keyOf = (i: number): string | null => {
    if (source === "jp") {
      if (!isFinite(jpTrend[i])) return null;
      return singleKey(trendSign(jpTrend[i], T));
    }
    if (source === "us") {
      if (!isFinite(usTrend[i])) return null;
      return singleKey(trendSign(usTrend[i], T));
    }
    if (!isFinite(jpTrend[i]) || !isFinite(usTrend[i])) return null;
    return concordKey(trendSign(jpTrend[i], T), trendSign(usTrend[i], T));
  };

  // ── 前夜米国ビンは全標本共通境界(バケツ間で米陽/米陰の意味を揃える) ──
  const usVals = rows.map((a) => a.us.ret);
  const binIdx = assignBins(usVals, usScheme);
  const usEdges = binEdges(usVals, usScheme);
  const usMeta = binMeta(usScheme);

  const defs = bucketDefs(source);
  const buckets: RegimeBucket[] = [];
  let maxAbs = 1e-6;

  for (const def of defs) {
    // このバケツに属する行インデックス
    const idxs: number[] = [];
    rows.forEach((_, i) => { if (keyOf(i) === def.key) idxs.push(i); });

    // 前夜米国ビン別にパスをまとめる
    const groups: PathGroup[] = [];
    for (let b = 0; b < usMeta.count; b++) {
      const paths = idxs
        .filter((i) => binIdx[i] === b)
        .map((i) => dayCumPath(rows[i].jp, grid, gmtoffset));
      groups.push({ key: String(b), label: usMeta.labels[b], color: usMeta.colors[b], paths });
    }
    const { stats, maxAbs: mA } = buildPathStats(groups, G);
    maxAbs = Math.max(maxAbs, mA);
    const usPairDiffs = pairwiseEndDiffs(stats);

    // スピルオーバー強度 = 米国最上位ビン − 最下位ビン の終端差
    const hi = stats[usMeta.count - 1], lo = stats[0];
    const spilloverSpread = (hi?.endMean ?? 0) - (lo?.endMean ?? 0);
    const pd = usPairDiffs.find((d) => d.i === 0 && d.j === usMeta.count - 1);

    buckets.push({
      key: def.key, label: def.label, color: def.color, n: idxs.length,
      usStats: stats, usPairDiffs,
      spilloverSpread, spreadP: pd ? pd.p : 1, spreadPAdj: pd ? pd.pAdj : 1,
    });
  }

  // ── 原系列タイムライン: 各日を所属バケツ色で ──
  const days = rows
    .map((a, i) => ({ date: a.jp.date, close: a.jp.close, regimeKey: keyOf(i) ?? "mid" }))
    .filter((d) => d.close > 0);

  // ── 直近の前夜米国(=ビン軸)。最新の米国セッションが未ペアなら寄り前・未反映として採る ──
  let latestUs: RegimeUsPathResult["latestUs"] = null;
  if (rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    let ud = lastRow.us.date, uv = lastRow.us.ret;
    if (usSorted.length > 0) {
      const latest = usSorted[usSorted.length - 1]; // usSorted は isFinite(ret) 済み・昇順
      if (latest.date > lastRow.us.date) { ud = latest.date; uv = latest.ret; }
    }
    const le = usVals.filter((v) => v <= uv).length;
    latestUs = {
      date: ud, value: uv, bin: binOfValue(uv, usScheme, usEdges),
      unpaired: ud > lastRow.us.date, percentile: usVals.length ? le / usVals.length : 0.5,
    };
  }

  // ── 「今日」= 次セッションに入る時点の基調(最新の確定日まで含む直近K日) ──
  let today: RegimeUsPathResult["today"] = null;
  const n = rows.length;
  if (n >= K) {
    let js = 0;
    for (let k = 0; k < K; k++) js += jpRet[n - 1 - k];
    const lastUs = usIdx.get(rows[n - 1].us.date);
    let usT: number | null = null;
    if (lastUs !== undefined && lastUs >= K - 1) {
      let s = 0;
      for (let k = 0; k < K; k++) s += usSorted[lastUs - k].ret;
      usT = s;
    }
    let key: string;
    if (source === "jp") key = singleKey(trendSign(js, T));
    else if (source === "us") key = usT !== null ? singleKey(trendSign(usT, T)) : "flat";
    else key = usT !== null ? concordKey(trendSign(js, T), trendSign(usT, T)) : "mid";
    const label = defs.find((d) => d.key === key)?.label ?? key;
    today = { jpTrend: js, usTrend: usT, regimeKey: key, label };
  }

  return {
    source, K, thresholdPct, usScheme,
    usBinLabels: usMeta.labels, usBinColors: usMeta.colors, usBinEdges: usEdges,
    buckets, timeLabels: grid.bins.map((x) => x.label), maxAbs, days, latestUs, today,
  };
}
