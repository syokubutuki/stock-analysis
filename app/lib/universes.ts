// クロスセクション分析用の「ユニバース」プリセット。
// -------------------------------------------------------------
// 6銘柄では横断の標本(ブレッドス)が小さすぎて小エッジを検出できない。そこで流動性の高い
// (=スプレッドの薄い)大型株を数十本まとめて読み込み、breadth を桁上げして真価を確かめる。
//
// 重要(生存者バイアス): これらは「現在の」主要銘柄リストであり、過去に上場廃止・統合で
// 消えた銘柄を含まない=生存者バイアスあり。cross-sectional-edge.ts の point-in-time 診断が
// 「全銘柄が終端まで生存」を検出して警告する。真の時点構成メンバーが要る点は変わらない。

export interface UniverseDef {
  id: string;
  label: string;
  note: string;
  tickers: { ticker: string; name: string }[];
}

// 東証プライムの大型・高流動(スプレッドが薄い)銘柄。TOPIX Core30 級 + 主要大型。
const CORE30: { ticker: string; name: string }[] = [
  { ticker: "7203.T", name: "トヨタ自動車" },
  { ticker: "6758.T", name: "ソニーグループ" },
  { ticker: "6861.T", name: "キーエンス" },
  { ticker: "9984.T", name: "ソフトバンクG" },
  { ticker: "8306.T", name: "三菱UFJ FG" },
  { ticker: "9432.T", name: "日本電信電話" },
  { ticker: "6098.T", name: "リクルートHD" },
  { ticker: "8035.T", name: "東京エレクトロン" },
  { ticker: "9433.T", name: "KDDI" },
  { ticker: "4063.T", name: "信越化学工業" },
  { ticker: "8058.T", name: "三菱商事" },
  { ticker: "7974.T", name: "任天堂" },
  { ticker: "6902.T", name: "デンソー" },
  { ticker: "4519.T", name: "中外製薬" },
  { ticker: "8316.T", name: "三井住友FG" },
  { ticker: "6367.T", name: "ダイキン工業" },
  { ticker: "7267.T", name: "本田技研工業" },
  { ticker: "7741.T", name: "HOYA" },
  { ticker: "4568.T", name: "第一三共" },
  { ticker: "4502.T", name: "武田薬品工業" },
  { ticker: "6503.T", name: "三菱電機" },
  { ticker: "8766.T", name: "東京海上HD" },
  { ticker: "9983.T", name: "ファーストリテイリング" },
  { ticker: "4661.T", name: "オリエンタルランド" },
  { ticker: "8001.T", name: "伊藤忠商事" },
  { ticker: "8802.T", name: "三菱地所" },
  { ticker: "9020.T", name: "JR東日本" },
  { ticker: "6981.T", name: "村田製作所" },
  { ticker: "6301.T", name: "小松製作所" },
  { ticker: "2914.T", name: "日本たばこ産業" },
];

// 主要60: Core30 + さらに流動性の高い大型を追加。
const EXTRA30: { ticker: string; name: string }[] = [
  { ticker: "6501.T", name: "日立製作所" },
  { ticker: "8031.T", name: "三井物産" },
  { ticker: "8411.T", name: "みずほFG" },
  { ticker: "6594.T", name: "ニデック" },
  { ticker: "6146.T", name: "ディスコ" },
  { ticker: "6273.T", name: "SMC" },
  { ticker: "7011.T", name: "三菱重工業" },
  { ticker: "4901.T", name: "富士フイルムHD" },
  { ticker: "5108.T", name: "ブリヂストン" },
  { ticker: "4578.T", name: "大塚HD" },
  { ticker: "8053.T", name: "住友商事" },
  { ticker: "8591.T", name: "オリックス" },
  { ticker: "8267.T", name: "イオン" },
  { ticker: "9022.T", name: "JR東海" },
  { ticker: "9101.T", name: "日本郵船" },
  { ticker: "5401.T", name: "日本製鉄" },
  { ticker: "6902.T", name: "デンソー" },
  { ticker: "7751.T", name: "キヤノン" },
  { ticker: "6752.T", name: "パナソニックHD" },
  { ticker: "6702.T", name: "富士通" },
  { ticker: "4543.T", name: "テルモ" },
  { ticker: "4523.T", name: "エーザイ" },
  { ticker: "2802.T", name: "味の素" },
  { ticker: "4452.T", name: "花王" },
  { ticker: "3382.T", name: "セブン&アイ" },
  { ticker: "9735.T", name: "セコム" },
  { ticker: "6954.T", name: "ファナック" },
  { ticker: "6971.T", name: "京セラ" },
  { ticker: "8113.T", name: "ユニ・チャーム" },
  { ticker: "4689.T", name: "LINEヤフー" },
];

// 中型・新興(メガキャップより裁定が緩くエッジが残りやすい一方、スプレッド・容量の壁が厳しい)。
// 現構成のため生存者バイアスは大型より深刻(小型ほど上場廃止・破綻が多く、消えた敗者が抜けている)。
// 実在しない/データ不足の銘柄は取得時に自動で外れる(≥260営業日フィルタ)ので、多少の欠けは許容。
const MIDSMALL: { ticker: string; name: string }[] = [
  { ticker: "2432.T", name: "ディー・エヌ・エー" },
  { ticker: "3659.T", name: "ネクソン" },
  { ticker: "3765.T", name: "ガンホー" },
  { ticker: "4385.T", name: "メルカリ" },
  { ticker: "2371.T", name: "カカクコム" },
  { ticker: "3092.T", name: "ZOZO" },
  { ticker: "4751.T", name: "サイバーエージェント" },
  { ticker: "2413.T", name: "エムスリー" },
  { ticker: "6532.T", name: "ベイカレント" },
  { ticker: "4443.T", name: "Sansan" },
  { ticker: "4478.T", name: "freee" },
  { ticker: "3993.T", name: "PKSHA Technology" },
  { ticker: "3900.T", name: "クラウドワークス" },
  { ticker: "4477.T", name: "BASE" },
  { ticker: "6035.T", name: "IRジャパンHD" },
  { ticker: "4485.T", name: "JTOWER" },
  { ticker: "2127.T", name: "日本M&Aセンター" },
  { ticker: "3038.T", name: "神戸物産" },
  { ticker: "3141.T", name: "ウエルシアHD" },
  { ticker: "3549.T", name: "クスリのアオキHD" },
  { ticker: "7532.T", name: "パン・パシフィック(ドンキ)" },
  { ticker: "2695.T", name: "くら寿司" },
  { ticker: "3097.T", name: "物語コーポレーション" },
  { ticker: "7581.T", name: "サイゼリヤ" },
  { ticker: "2670.T", name: "ABCマート" },
  { ticker: "2811.T", name: "カゴメ" },
  { ticker: "2702.T", name: "日本マクドナルドHD" },
  { ticker: "6544.T", name: "ジャパンエレベーター" },
];

function dedupe(rows: { ticker: string; name: string }[]): { ticker: string; name: string }[] {
  const seen = new Set<string>();
  const out: { ticker: string; name: string }[] = [];
  for (const r of rows) { if (!seen.has(r.ticker)) { seen.add(r.ticker); out.push(r); } }
  return out;
}

export const UNIVERSES: UniverseDef[] = [
  {
    id: "core30",
    label: "大型30（TOPIX Core30 級）",
    note: "最も流動性が高くスプレッドが薄い30本。横断の入口として速い。",
    tickers: dedupe(CORE30),
  },
  {
    id: "major60",
    label: "主要60（大型・高流動）",
    note: "大型60本。ブレッドスを桁上げして小エッジの検出力を上げる。取得に時間がかかる。",
    tickers: dedupe([...CORE30, ...EXTRA30]),
  },
  {
    id: "midsmall",
    label: "中型・新興（裁定が緩い代わりにスプレッド大）",
    note: "メガキャップより裁定が緩くエッジが残りやすいが、スプレッド・容量の壁が厳しく生存者バイアスも深刻。真の小型はコード貼り付けで。",
    tickers: dedupe(MIDSMALL),
  },
];

export function getUniverse(id: string): UniverseDef | undefined {
  return UNIVERSES.find((u) => u.id === id);
}
