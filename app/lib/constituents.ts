// 構成銘柄の取り込み「器」: point-in-time メンバーシップ + 廃止銘柄価格を、
// クロスセクション・エンジンの既存インターフェース(pricesByTicker + membership)へ流し込む前処理層。
// -------------------------------------------------------------------------------
// なぜ必要か: 現状の横断分析は「Yahooがデータを持つ期間=在籍」に等しく、上場廃止で消えた
// 敗者は存在ごと欠落する(生存者バイアス)。在籍日付だけでは直らず、律速は「もう存在しない銘柄の
// 価格系列(倒産なら≒0への最後の一手を含む)をどう入手し、損益に反映するか」にある。
//
// この器の設計方針(エンジン非改修):
//   ・時変メンバーシップを区間リストで表現(追加→除外→再追加、発効日、除外理由)。
//   ・除外理由 reason で終端の意味を分ける:
//       index-drop … 指数落ちだが上場継続 → ユニバースを時価で離脱(損益ショックなし)。
//       merger      … 吸収合併 → 終端に交換価値(terminalPrice)を1発計上。無指定なら clean 扱い。
//       delist-zero … 上場廃止/倒産 → 終端に≒0の合成バーを価格系列へ追加し、最後の急落を損益化。
//   ・出力は「マージ済み pricesByTicker(廃止銘柄価格 + 合成終端バー)」と「単一区間 membership」。
//     終端処理を価格側に畳み込むことで、エンジン(computeCrossSectional)は無改修のまま
//     倒産損失を拾える。多区間(再入場)の gap ゲートだけはエンジン増分が要る(下記 warning)。
import { PricePoint } from "./types";

export type MembershipReason = "active" | "index-drop" | "merger" | "delist-zero";

export interface MembershipInterval {
  ticker: string;
  name?: string;
  from: string; // "YYYY-MM-DD" 組入(発効日)
  to?: string; // "YYYY-MM-DD" 除外/廃止(発効日)。未指定=現在も在籍(active)
  reason?: MembershipReason; // to の理由。未指定は to があれば index-drop、無ければ active
  terminalPrice?: number; // merger/delist-zero の終端価格(絶対値・任意)。無指定なら reason 既定
}

export interface ConstituentTable {
  intervals: MembershipInterval[];
}

// ---------------------------------------------------------------
// 正規化ユーティリティ
// ---------------------------------------------------------------
function normTicker(raw: string): string {
  const t = raw.trim().toUpperCase();
  return /^\d{4}$/.test(t) ? `${t}.T` : t; // 4桁数字は東証とみなし .T 補完
}

function normDate(raw: string): string | undefined {
  const s = raw.trim().replace(/\//g, "-");
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return undefined;
  const y = m[1], mo = m[2].padStart(2, "0"), d = m[3].padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

function normReason(raw: string | undefined, hasTo: boolean): MembershipReason {
  const s = (raw ?? "").trim().toLowerCase();
  if (["delist-zero", "delist", "bankrupt", "廃止", "上場廃止", "倒産", "zero"].includes(s)) return "delist-zero";
  if (["merger", "merge", "合併", "統合", "吸収"].includes(s)) return "merger";
  if (["index-drop", "drop", "除外", "指数落ち", "除外指数"].includes(s)) return "index-drop";
  if (["active", "在籍", ""].includes(s)) return hasTo ? "index-drop" : "active";
  return hasTo ? "index-drop" : "active";
}

function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------
// CSV パース: ticker,from,to,reason,name (ヘッダ任意・区切りは , / タブ / 空白)
// ---------------------------------------------------------------
export function parseMembershipCsv(raw: string): { intervals: MembershipInterval[]; errors: string[] } {
  const intervals: MembershipInterval[] = [];
  const errors: string[] = [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // ヘッダ行(ticker/code/銘柄 等を含み日付を含まない)はスキップ
    if (li === 0 && /ticker|code|銘柄|from|開始/i.test(line) && !/\d{4}-\d{1,2}-\d{1,2}/.test(line)) continue;
    const cols = line.split(/[,\t]+/).map((c) => c.trim());
    if (cols.length < 2) { errors.push(`行${li + 1}: 列不足 "${line}"`); continue; }
    const ticker = normTicker(cols[0]);
    const from = normDate(cols[1]);
    if (!ticker || !from) { errors.push(`行${li + 1}: ticker/from が不正 "${line}"`); continue; }
    const to = cols[2] ? normDate(cols[2]) : undefined;
    const reason = normReason(cols[3], !!to);
    const name = cols[4] || undefined;
    const terminalPrice = cols[5] && isFinite(Number(cols[5])) ? Number(cols[5]) : undefined;
    intervals.push({ ticker, name, from, to, reason, terminalPrice });
  }
  return { intervals, errors };
}

// 現構成リスト(ticker+name)に一律の組入日 from を与えて active 区間化する簡便関数。
export function intervalsFromCurrentList(
  list: { ticker: string; name?: string }[],
  from: string,
): MembershipInterval[] {
  const f = normDate(from) ?? from;
  return list.map((x) => ({ ticker: normTicker(x.ticker), name: x.name, from: f, reason: "active" as MembershipReason }));
}

// ---------------------------------------------------------------
// as-of メンバー集合。to は「除外発効日」= その日は既にユニバース外(最終在籍日は前日)。
// ---------------------------------------------------------------
export function membersOn(intervals: MembershipInterval[], date: string): Set<string> {
  const out = new Set<string>();
  for (const iv of intervals) {
    if (iv.from <= date && (!iv.to || date < iv.to)) out.add(iv.ticker);
  }
  return out;
}

// ---------------------------------------------------------------
// 外部(廃止銘柄)価格系列: 終値のみでも可。PricePoint に昇格。
// ---------------------------------------------------------------
export interface ClosePoint { time: string; close: number; }

function toPricePoints(series: ClosePoint[]): PricePoint[] {
  return series
    .filter((p) => p.close > 0)
    .map((p) => ({ time: p.time.slice(0, 10), open: p.close, high: p.close, low: p.close, close: p.close, volume: 0 }));
}

// ---------------------------------------------------------------
// 適用: マージ済み価格 + 単一区間 membership + 診断 を返す。
// ---------------------------------------------------------------
export interface ApplyConstituentsInput {
  pricesByTicker: Record<string, PricePoint[]>; // Yahoo取得分(現存銘柄)
  intervals: MembershipInterval[];
  delistedPrices?: Record<string, ClosePoint[]>; // Yahooに無い廃止銘柄の価格(外部供給)
  delistZeroFraction?: number; // delist-zero の終端価格 = 直近終値 × これ(既定0.01=99%毀損)
}

export interface ConstituentDiagnostics {
  nIntervals: number;
  nTickers: number;
  nSurvivors: number; // reason=active(=まだ在籍)の銘柄数
  nIndexDrop: number;
  nMerger: number;
  nDelistZero: number;
  survivorFraction: number; // 生存者の割合(1に近いほど生存者バイアス懸念)
  coverage: number; // 価格データが得られた区間の割合(0..1)
  missingPrice: string[]; // 価格が無くユニバースに入れられない ticker
  multiIntervalTickers: string[]; // 再入場(複数区間)=エンジンの gap ゲートは未対応の注意対象
  syntheticTerminals: number; // 合成終端バーを追加した数(delist-zero/merger)
}

export interface ApplyConstituentsResult {
  pricesByTicker: Record<string, PricePoint[]>; // マージ + 合成終端バー
  names: Record<string, string>;
  membership: Record<string, { from?: string; to?: string }>; // エンジン受け口(単一区間)
  diagnostics: ConstituentDiagnostics;
  intervals: MembershipInterval[]; // 正規化済み(as-of 用に保持)
}

export function applyConstituents(input: ApplyConstituentsInput): ApplyConstituentsResult {
  const { intervals } = input;
  const zeroFrac = input.delistZeroFraction ?? 0.01;
  const delisted = input.delistedPrices ?? {};

  // ticker → 区間群
  const byTicker = new Map<string, MembershipInterval[]>();
  for (const iv of intervals) {
    const arr = byTicker.get(iv.ticker) ?? [];
    arr.push(iv);
    byTicker.set(iv.ticker, arr);
  }

  const outPrices: Record<string, PricePoint[]> = {};
  const names: Record<string, string> = {};
  const membership: Record<string, { from?: string; to?: string }> = {};
  const missingPrice: string[] = [];
  const multiIntervalTickers: string[] = [];
  let syntheticTerminals = 0;

  for (const [ticker, ivs] of byTicker) {
    ivs.sort((a, b) => a.from.localeCompare(b.from));
    if (ivs.length > 1) multiIntervalTickers.push(ticker);
    const nm = ivs.find((v) => v.name)?.name ?? ticker;
    names[ticker] = nm;

    // 価格: Yahoo優先、無ければ外部(廃止)を採用。両方あれば長い方。
    const yahoo = input.pricesByTicker[ticker] ?? [];
    const ext = delisted[ticker] ? toPricePoints(delisted[ticker]) : [];
    let prices = yahoo.length >= ext.length ? yahoo.slice() : ext.slice();
    if (prices.length === 0) { missingPrice.push(ticker); continue; }
    prices = prices.filter((p) => p.close > 0).sort((a, b) => a.time.localeCompare(b.time));
    if (prices.length === 0) { missingPrice.push(ticker); continue; }

    // 終端処理: 最も新しい to を持つ区間の理由で終端を決める(倒産/合併なら合成バー)。
    const lastReal = prices[prices.length - 1].time.slice(0, 10);
    const lastClose = prices[prices.length - 1].close;
    const closing = ivs.filter((v) => v.to).sort((a, b) => (b.to as string).localeCompare(a.to as string))[0];
    if (closing && (closing.reason === "delist-zero" || closing.reason === "merger")) {
      const to = closing.to as string;
      const termPrice = closing.terminalPrice != null
        ? closing.terminalPrice
        : closing.reason === "delist-zero"
          ? Math.max(1e-6, lastClose * zeroFrac)
          : lastClose; // merger で価格未指定なら clean(価格変化なし)扱い
      // 既存データが to まで届いていない、かつ merger の clean 以外なら終端バーを1本追加。
      const needTerminal = to > lastReal && !(closing.reason === "merger" && closing.terminalPrice == null);
      if (needTerminal) {
        const tdate = to > lastReal ? to : nextDay(lastReal);
        prices.push({ time: tdate, open: termPrice, high: Math.max(termPrice, lastClose), low: Math.min(termPrice, lastClose), close: termPrice, volume: 0 });
        syntheticTerminals++;
      }
    }
    outPrices[ticker] = prices;

    // membership(単一区間): 多区間は covering[min from, max to] に畳む(gap は未対応→warning)。
    const from = ivs[0].from;
    // 最終区間が active(to無し)なら to は undefined。全区間 closed なら最大 to。
    const anyActive = ivs.some((v) => !v.to);
    const to = anyActive ? undefined : ivs.map((v) => v.to as string).sort().slice(-1)[0];
    membership[ticker] = { from, to };
  }

  const reasonsByTicker = new Map<string, MembershipReason>();
  for (const [ticker, ivs] of byTicker) {
    const closing = ivs.filter((v) => v.to).sort((a, b) => (b.to as string).localeCompare(a.to as string))[0];
    reasonsByTicker.set(ticker, closing?.reason ?? "active");
  }
  const nTickers = byTicker.size;
  const withPrice = nTickers - missingPrice.length;
  const count = (r: MembershipReason) => [...reasonsByTicker.values()].filter((x) => x === r).length;
  const nSurvivors = count("active");

  const diagnostics: ConstituentDiagnostics = {
    nIntervals: intervals.length,
    nTickers,
    nSurvivors,
    nIndexDrop: count("index-drop"),
    nMerger: count("merger"),
    nDelistZero: count("delist-zero"),
    survivorFraction: nTickers > 0 ? nSurvivors / nTickers : 0,
    coverage: nTickers > 0 ? withPrice / nTickers : 0,
    missingPrice,
    multiIntervalTickers,
    syntheticTerminals,
  };

  return { pricesByTicker: outPrices, names, membership, diagnostics, intervals };
}
