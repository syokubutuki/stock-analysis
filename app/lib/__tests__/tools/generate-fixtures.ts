// テスト用フィクスチャの生成スクリプト（テスト実行時には走らない）。
//
//   npx tsx app/lib/__tests__/tools/generate-fixtures.ts
//   npx tsx app/lib/__tests__/tools/generate-fixtures.ts --search   （SEED の再探索）
//
// 生成物 `app/lib/__tests__/fixtures/price-fixtures.json` はリポジトリにコミットする。
// テストは JSON を読むだけで、この生成器には依存しない（＝生成器を直しても黄金値は動かない）。
// 生成器を意図的に変えたときは JSON と、テスト側の黄金値の両方を録り直すこと。
//
// ## 合成データを使う理由
//
// 事故当時（2026-03-30〜31）の 1306.T の生配信は、上流が後から修正すれば再取得できない。
// また CLAUDE.md の規約により、テストから Yahoo Finance を直接叩くことはしない。
// そこで **事故の構造だけを再現した合成系列** を固定する:
//   ・ベンチマーク（1306.T 役）の 2 営業日だけ OHLC が 1/10、出来高が 10 倍
//   ・対象銘柄は真のβ = 1.10 で連動（ベンチマークの「壊れていない側」に対して）
// SEED は、この再現が CLAUDE.md の見出し数値（β 1.10 → 0.05）に最も近く落ちるものを
// `--search` で選んである。合成であることを承知のうえで、事故の大きさに揃えている。

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32, makeNormal } from "../helpers/rng";
import { olsBeta } from "../helpers/golden";
import type { PricePoint } from "../../types";

/** `--search` で選んだ種。変えるとフィクスチャ全体が変わる。 */
const SEED = 36677;
/** 破損させる営業日の先頭インデックス（0 始まり）と日数。 */
const GLITCH_START = 121;
const GLITCH_DAYS = 2;
/** 破損倍率。1306.T の実例と同じ 1/10。 */
const GLITCH_FACTOR = 0.1;
/** 対象銘柄の真のβ。 */
const TRUE_BETA = 1.1;

const N_DAYS = 250;

function businessDays(startISO: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${startISO}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

interface SeriesSpec {
  s0: number;
  /** 日次対数リターン列（長さ n−1 ではなく n。先頭日は始値→終値のみ使う） */
  logRets: number[];
  /** 夜間ギャップ（前日終値→当日始値）の対数 */
  gaps: number[];
  /** 日中の高安レンジ（対数） */
  ranges: number[];
  baseVolume: number;
  volNoise: number[];
}

function buildSeries(times: string[], spec: SeriesSpec): PricePoint[] {
  const out: PricePoint[] = [];
  let prevClose = spec.s0;
  for (let i = 0; i < times.length; i++) {
    const open = i === 0 ? prevClose : prevClose * Math.exp(spec.gaps[i]);
    const close = prevClose * Math.exp(spec.logRets[i]);
    const half = Math.abs(spec.ranges[i]) / 2;
    const hi = Math.max(open, close) * Math.exp(half);
    const lo = Math.min(open, close) * Math.exp(-half);
    out.push({
      time: times[i],
      open,
      high: hi,
      low: lo,
      close,
      volume: Math.round(spec.baseVolume * Math.exp(spec.volNoise[i])),
    });
    prevClose = close;
  }
  return out;
}

/** OHLC を factor 倍・出来高を 1/factor 倍にする（上流の分割調整の当て間違いの再現）。 */
function corrupt(prices: PricePoint[], start: number, days: number, factor: number): PricePoint[] {
  return prices.map((p, i) => {
    if (i < start || i >= start + days) return p;
    return {
      time: p.time,
      open: p.open * factor,
      high: p.high * factor,
      low: p.low * factor,
      close: p.close * factor,
      volume: Math.round(p.volume / factor),
    };
  });
}

function closeLogRets(prices: PricePoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) out.push(Math.log(prices[i].close / prices[i - 1].close));
  return out;
}

interface Built {
  benchmarkClean: PricePoint[];
  benchmarkRaw: PricePoint[];
  stock: PricePoint[];
  betaRaw: number;
  betaClean: number;
}

function build(seed: number): Built {
  const rand = mulberry32(seed);
  const norm = makeNormal(rand);
  const times = businessDays("2025-04-01", N_DAYS);

  // ベンチマーク（1306.T 役）: 日次σ ≈ 1.3%（事故当時の実測と同じ水準）
  const mktRets = Array.from({ length: N_DAYS }, () => 0.0002 + 0.013 * norm());
  const mktGaps = mktRets.map((r) => r * 0.4 + 0.004 * norm());
  const mktRanges = Array.from({ length: N_DAYS }, () => 0.008 + 0.004 * Math.abs(norm()));
  const mktVolNoise = Array.from({ length: N_DAYS }, () => 0.3 * norm());

  // 対象銘柄: 壊れていない側の市場リターンに β = 1.10 で連動 + 固有ノイズ
  const stockRets = mktRets.map((r) => TRUE_BETA * r + 0.005 * norm());
  const stockGaps = stockRets.map((r) => r * 0.4 + 0.005 * norm());
  const stockRanges = Array.from({ length: N_DAYS }, () => 0.010 + 0.005 * Math.abs(norm()));
  const stockVolNoise = Array.from({ length: N_DAYS }, () => 0.3 * norm());

  const benchmarkClean = buildSeries(times, {
    s0: 382.7,
    logRets: mktRets,
    gaps: mktGaps,
    ranges: mktRanges,
    baseVolume: 25_000_000,
    volNoise: mktVolNoise,
  });
  const stock = buildSeries(times, {
    s0: 2800,
    logRets: stockRets,
    gaps: stockGaps,
    ranges: stockRanges,
    baseVolume: 8_000_000,
    volNoise: stockVolNoise,
  });
  const benchmarkRaw = corrupt(benchmarkClean, GLITCH_START, GLITCH_DAYS, GLITCH_FACTOR);

  const y = closeLogRets(stock);
  return {
    benchmarkClean,
    benchmarkRaw,
    stock,
    betaRaw: olsBeta(y, closeLogRets(benchmarkRaw)),
    betaClean: olsBeta(y, closeLogRets(benchmarkClean)),
  };
}

/**
 * 誤検出の対照群。どちらも「往復する大きなジャンプ」だが修復してはいけない。
 *   tnx : ^TNX 2020-03-09 型。倍率が 2/3 に近い＝1 の近傍なので候補外（MIN_LOG_FACTOR）
 *   vix : ^VIX 型。+80% 急騰→数日で急落。倍率が端数で切りのいい比に一致しない
 */
function buildGuards(seed: number): { tnx: PricePoint[]; vix: PricePoint[] } {
  const rand = mulberry32(seed);
  const norm = makeNormal(rand);
  const times = businessDays("2020-02-03", 60);

  const mk = (s0: number, dailySigma: number, shocks: Record<number, number>): PricePoint[] => {
    const rets = Array.from({ length: 60 }, (_, i) => {
      const base = dailySigma * norm();
      return shocks[i] !== undefined ? shocks[i] : base;
    });
    return buildSeries(times, {
      s0,
      logRets: rets,
      gaps: rets.map((r) => r * 0.4),
      ranges: rets.map((r) => Math.abs(r) * 0.5 + 0.005),
      baseVolume: 1_000_000,
      volNoise: rets.map(() => 0),
    });
  };

  // 0.75% → 0.5% へ急落し、3営業日で戻す（倍率 2/3 相当）。
  // 日次σは 2.5% に置き、疑い報告の門（8σ）を確実に超える側に寄せてある
  // ＝「修復はしないが疑いとしては報告する」経路をテストで踏むため。
  const tnx = mk(0.78, 0.025, { 25: Math.log(2 / 3), 28: Math.log(3 / 2) });
  // +80% 急騰 → 3営業日で元へ（倍率 1/1.8 = 0.5556。切りのいい比ではない）
  const vix = mk(15, 0.08, { 30: Math.log(1.8), 33: Math.log(1 / 1.8) });
  return { tnx, vix };
}

function main(): void {
  if (process.argv.includes("--search")) {
    let best = { seed: SEED, score: Infinity, betaRaw: 0, betaClean: 0 };
    for (let seed = 1; seed <= 40000; seed++) {
      const b = build(seed);
      const score = Math.abs(b.betaClean - 1.1) * 10 + Math.abs(b.betaRaw - 0.05);
      if (score < best.score) best = { seed, score, betaRaw: b.betaRaw, betaClean: b.betaClean };
    }
    console.log("best seed:", best);
    return;
  }

  const built = build(SEED);
  const guards = buildGuards(SEED);
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
  mkdirSync(outDir, { recursive: true });
  const payload = {
    _comment:
      "生成物。手で編集しない。app/lib/__tests__/tools/generate-fixtures.ts で再生成する。",
    seed: SEED,
    glitch: { start: GLITCH_START, days: GLITCH_DAYS, factor: GLITCH_FACTOR },
    trueBeta: TRUE_BETA,
    benchmarkRaw: built.benchmarkRaw,
    benchmarkClean: built.benchmarkClean,
    stock: built.stock,
    tnx: guards.tnx,
    vix: guards.vix,
  };
  writeFileSync(join(outDir, "price-fixtures.json"), `${JSON.stringify(payload)}\n`, "utf8");
  console.log("wrote fixtures.", {
    betaRaw: built.betaRaw,
    betaClean: built.betaClean,
  });
}

main();
