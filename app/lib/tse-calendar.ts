/**
 * 東京証券取引所の休場日カレンダー（規則による算出＋特例の静的表）。
 *
 * ## 何のためにあるか
 *
 * 配信元（Yahoo Finance）の東証銘柄の日足には、2017-07〜2018-12 の東証休場日（祝日・振替休日・
 * 年末年始）に **出来高0・四本値＝前日終値** の「幻の行」が混じっている（実測は
 * docs/phantom-holiday-rows.md）。この行を「出来高0かつ値動きなし」だけで判定すると、
 * 気配のまま売買が成立しなかった**本物の立会日**（エーザイ 2019-03-25・オムロン 2019-03-11 等）
 * まで消してしまう。両者を分ける唯一の手掛かりは「その日に取引所が開いていたか」なので、
 * 休場日を価格データとは独立に持つ。price-sanity.ts の休場日行の除去だけがこれを使う。
 *
 * ## 範囲と保守性
 *
 * - 祝日法の規則（ハッピーマンデー・春分/秋分の近似式・振替休日・国民の休日）で 2000〜2099 年を
 *   算出し、法律で個別に動いた日（2019 の即位関連、2020/2021 の五輪移動）は特例表で上書きする。
 * - 将来、特例の祝日が新設されてもこの表は知らない。その場合は「休場日と判定できない」側に
 *   倒れる（＝幻の行を見逃すだけで、正しい行を消すことはない）。
 * - 範囲外の年は判定しない（null）。
 *
 * 2016-10〜2026-09 の 7203.T 等の実配信と照合し、配信に行が無い平日＋幻の行の日付が
 * この表の休場日と過不足なく一致することを確認済み（docs/phantom-holiday-rows.md §2）。
 */

const MIN_YEAR = 2000;
const MAX_YEAR = 2099;

/** 祝日法の規則では表せない、法律で個別に定めた祝日・移動（YYYY-MM-DD → 名称）。 */
const SPECIAL_HOLIDAYS: Record<string, string> = {
  "2019-05-01": "即位の日",
  "2019-10-22": "即位礼正殿の儀",
  // 東京五輪特措法による移動（2020・2021 は 7月に海の日・スポーツの日、8月に山の日）。
  "2020-07-23": "海の日",
  "2020-07-24": "スポーツの日",
  "2020-08-10": "山の日",
  "2021-07-22": "海の日",
  "2021-07-23": "スポーツの日",
  "2021-08-08": "山の日",
};

/** 五輪特措法で通常の日付から外れた年（規則による算出を止める）。 */
const MOVED_YEARS: Record<string, readonly number[]> = {
  umi: [2020, 2021],
  yama: [2020, 2021],
  sports: [2020, 2021],
};

/**
 * 祝日ではない終日休場（売買停止）。
 * 2020-10-01 は株式売買システム arrowhead の障害で全銘柄が終日売買停止になった。
 */
const SPECIAL_CLOSURES: Record<string, string> = {
  "2020-10-01": "終日売買停止（arrowhead 障害）",
};

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 曜日（0=日〜6=土）。暦日の計算なのでタイムゾーンに依存しない UTC で数える。 */
function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** m 月の第 n 月曜日の日。 */
function nthMonday(y: number, m: number, n: number): number {
  const first = dayOfWeek(y, m, 1);
  return 1 + ((8 - first) % 7) + (n - 1) * 7;
}

/** 春分日・秋分日（1980〜2099 年で有効な近似式。国立天文台の暦要項と一致する）。 */
function equinoxDay(y: number, base: number): number {
  return Math.floor(base + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

const yearCache = new Map<number, Map<string, string>>();

/** その年の祝日・振替休日・国民の休日（YYYY-MM-DD → 名称）。 */
function holidaysOf(y: number): Map<string, string> {
  const cached = yearCache.get(y);
  if (cached) return cached;

  const base = new Map<string, string>();
  const add = (m: number, d: number, name: string) => base.set(iso(y, m, d), name);

  add(1, 1, "元日");
  add(1, nthMonday(y, 1, 2), "成人の日");
  add(2, 11, "建国記念の日");
  if (y >= 2020) add(2, 23, "天皇誕生日");
  add(3, equinoxDay(y, 20.8431), "春分の日");
  add(4, 29, y >= 2007 ? "昭和の日" : "みどりの日");
  add(5, 3, "憲法記念日");
  if (y >= 2007) add(5, 4, "みどりの日");
  add(5, 5, "こどもの日");
  if (y >= 2003 && !MOVED_YEARS.umi.includes(y)) add(7, nthMonday(y, 7, 3), "海の日");
  if (y >= 2016 && !MOVED_YEARS.yama.includes(y)) add(8, 11, "山の日");
  if (y >= 2003) add(9, nthMonday(y, 9, 3), "敬老の日");
  add(9, equinoxDay(y, 23.2488), "秋分の日");
  if (!MOVED_YEARS.sports.includes(y)) {
    add(10, nthMonday(y, 10, 2), y >= 2020 ? "スポーツの日" : "体育の日");
  }
  add(11, 3, "文化の日");
  add(11, 23, "勤労感謝の日");
  if (y <= 2018) add(12, 23, "天皇誕生日");
  for (const [date, name] of Object.entries(SPECIAL_HOLIDAYS)) {
    if (date.startsWith(`${y}-`)) base.set(date, name);
  }

  const out = new Map(base);

  // 国民の休日: 前日と翌日がともに祝日である平日（2019-04-30/05-02, 2026-09-22 など）。
  for (let m = 1; m <= 12; m++) {
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) {
      const key = iso(y, m, d);
      if (base.has(key) || dayOfWeek(y, m, d) === 0) continue;
      const prev = new Date(Date.UTC(y, m - 1, d - 1));
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      const toKey = (t: Date) => t.toISOString().slice(0, 10);
      if (base.has(toKey(prev)) && base.has(toKey(next))) out.set(key, "国民の休日");
    }
  }

  // 振替休日: 祝日が日曜に当たったら、その後の最初の「祝日でない日」（2007 年以降の規則）。
  for (const key of base.keys()) {
    const [yy, mm, dd] = key.split("-").map(Number);
    if (dayOfWeek(yy, mm, dd) !== 0) continue;
    const t = new Date(Date.UTC(yy, mm - 1, dd + 1));
    if (y >= 2007) {
      while (out.has(t.toISOString().slice(0, 10))) t.setUTCDate(t.getUTCDate() + 1);
    }
    const sub = t.toISOString().slice(0, 10);
    if (!out.has(sub)) out.set(sub, "振替休日");
  }

  yearCache.set(y, out);
  return out;
}

/**
 * 東証が休場だった日なら理由を、立会日なら null を返す。
 * 対象範囲外の年・不正な日付も null（＝休場と断定しない。保守側）。
 *
 * @param time YYYY-MM-DD（PricePoint.time と同じ表記）
 */
export function tseClosureReason(time: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(time);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < MIN_YEAR || y > MAX_YEAR) return null;

  const dow = dayOfWeek(y, mo, d);
  if (dow === 0 || dow === 6) return dow === 0 ? "日曜日" : "土曜日";

  const special = SPECIAL_CLOSURES[time];
  if (special) return special;

  const holiday = holidaysOf(y).get(time);
  if (holiday) return holiday;

  // 年末年始休業（12/31・1/2・1/3。1/1 は元日として上で返る）。
  if ((mo === 12 && d === 31) || (mo === 1 && (d === 2 || d === 3))) return "年末年始休業";
  return null;
}

/**
 * 東証の立会カレンダーに従う系列か（休場日行の除去を適用してよいか）。
 *
 * `.T`（東証上場の株式・ETF・REIT）と、東証の立会日にだけ算出される指数に限る。
 * 投信（基準価額は投信の営業日で決まる）・米国・為替・金利は、東証が休みでも正当な値を持つので
 * 対象外。対象外の系列にはこの判定を一切当てない。
 */
export function followsTseCalendar(ticker: string): boolean {
  const t = ticker.trim().toUpperCase();
  return t.endsWith(".T") || TSE_CALENDAR_INDICES.has(t);
}

/** 東証の立会日にだけ算出される指数（休場日に値が存在しえない）。 */
const TSE_CALENDAR_INDICES = new Set(["^N225", "^TPX"]);
