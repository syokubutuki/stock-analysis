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

// 主要100: Core30 + Extra30 + さらに大型40。時価総額・流動性上位を業種横断で広く取り、
// 実効ブレッドスを100級へ引き上げて小エッジの検出力(IC t値 ≈ IC·√breadth)を最大化する。
// 既存60本と重複しない大型を、金融・素材・エネルギー・鉄道・化学・建設まで業種を広げて補う。
const EXTRA40: { ticker: string; name: string }[] = [
  { ticker: "9434.T", name: "ソフトバンク" },
  { ticker: "9613.T", name: "NTTデータG" },
  { ticker: "4324.T", name: "電通グループ" },
  { ticker: "6857.T", name: "アドバンテスト" },
  { ticker: "6762.T", name: "TDK" },
  { ticker: "6645.T", name: "オムロン" },
  { ticker: "6963.T", name: "ローム" },
  { ticker: "7733.T", name: "オリンパス" },
  { ticker: "4503.T", name: "アステラス製薬" },
  { ticker: "4507.T", name: "塩野義製薬" },
  { ticker: "4528.T", name: "小野薬品工業" },
  { ticker: "8002.T", name: "丸紅" },
  { ticker: "8015.T", name: "豊田通商" },
  { ticker: "8604.T", name: "野村HD" },
  { ticker: "8601.T", name: "大和証券グループ" },
  { ticker: "8725.T", name: "MS&AD" },
  { ticker: "8630.T", name: "SOMPO HD" },
  { ticker: "8308.T", name: "りそなHD" },
  { ticker: "8309.T", name: "三井住友トラストG" },
  { ticker: "8473.T", name: "SBI HD" },
  { ticker: "2502.T", name: "アサヒGHD" },
  { ticker: "2503.T", name: "キリンHD" },
  { ticker: "4911.T", name: "資生堂" },
  { ticker: "9843.T", name: "ニトリHD" },
  { ticker: "9021.T", name: "JR西日本" },
  { ticker: "9202.T", name: "ANA HD" },
  { ticker: "5020.T", name: "ENEOS HD" },
  { ticker: "1605.T", name: "INPEX" },
  { ticker: "5713.T", name: "住友金属鉱山" },
  { ticker: "3407.T", name: "旭化成" },
  { ticker: "4188.T", name: "三菱ケミカルG" },
  { ticker: "4005.T", name: "住友化学" },
  { ticker: "3402.T", name: "東レ" },
  { ticker: "5201.T", name: "AGC" },
  { ticker: "1925.T", name: "大和ハウス工業" },
  { ticker: "1928.T", name: "積水ハウス" },
  { ticker: "5802.T", name: "住友電気工業" },
  { ticker: "6326.T", name: "クボタ" },
  { ticker: "7012.T", name: "川崎重工業" },
  { ticker: "9531.T", name: "東京ガス" },
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

// ─── セクター別バスケット ───────────────────────────────────────────────
// 同一業種内だけで横断ランクを付けると、市場全体・セクター共通の変動(要因)が
// クロスセクションで相殺され、より純粋な「銘柄選択α」が残る。β中立・業種中立が
// 自然に締まり、案A(正史)が無くても同業種は生存確率が近いため生存者バイアスの
// 相対的な影響も小さい。→ 案Bの中では最優先(ブレッドスと純度を同時に得る)。

// 自動車・輸送用機器
const SEC_AUTO: { ticker: string; name: string }[] = [
  { ticker: "7203.T", name: "トヨタ自動車" },
  { ticker: "7267.T", name: "本田技研工業" },
  { ticker: "7201.T", name: "日産自動車" },
  { ticker: "7269.T", name: "スズキ" },
  { ticker: "7270.T", name: "SUBARU" },
  { ticker: "7261.T", name: "マツダ" },
  { ticker: "7211.T", name: "三菱自動車" },
  { ticker: "7202.T", name: "いすゞ自動車" },
  { ticker: "7205.T", name: "日野自動車" },
  { ticker: "7272.T", name: "ヤマハ発動機" },
  { ticker: "6902.T", name: "デンソー" },
  { ticker: "7259.T", name: "アイシン" },
  { ticker: "3116.T", name: "トヨタ紡織" },
  { ticker: "6201.T", name: "豊田自動織機" },
  { ticker: "7276.T", name: "小糸製作所" },
  { ticker: "5108.T", name: "ブリヂストン" },
  { ticker: "5101.T", name: "横浜ゴム" },
];

// 銀行・証券・保険(金融)
const SEC_FIN: { ticker: string; name: string }[] = [
  { ticker: "8306.T", name: "三菱UFJ FG" },
  { ticker: "8316.T", name: "三井住友FG" },
  { ticker: "8411.T", name: "みずほFG" },
  { ticker: "8308.T", name: "りそなHD" },
  { ticker: "8309.T", name: "三井住友トラストG" },
  { ticker: "7182.T", name: "ゆうちょ銀行" },
  { ticker: "8331.T", name: "千葉銀行" },
  { ticker: "8354.T", name: "ふくおかFG" },
  { ticker: "7186.T", name: "コンコルディアFG" },
  { ticker: "8591.T", name: "オリックス" },
  { ticker: "8604.T", name: "野村HD" },
  { ticker: "8601.T", name: "大和証券グループ" },
  { ticker: "8473.T", name: "SBI HD" },
  { ticker: "8766.T", name: "東京海上HD" },
  { ticker: "8725.T", name: "MS&AD" },
  { ticker: "8630.T", name: "SOMPO HD" },
  { ticker: "8795.T", name: "T&D HD" },
];

// 電機・精密・半導体
const SEC_TECH: { ticker: string; name: string }[] = [
  { ticker: "6758.T", name: "ソニーグループ" },
  { ticker: "6501.T", name: "日立製作所" },
  { ticker: "6503.T", name: "三菱電機" },
  { ticker: "6752.T", name: "パナソニックHD" },
  { ticker: "6702.T", name: "富士通" },
  { ticker: "6971.T", name: "京セラ" },
  { ticker: "6981.T", name: "村田製作所" },
  { ticker: "6861.T", name: "キーエンス" },
  { ticker: "6954.T", name: "ファナック" },
  { ticker: "6594.T", name: "ニデック" },
  { ticker: "6762.T", name: "TDK" },
  { ticker: "6645.T", name: "オムロン" },
  { ticker: "6963.T", name: "ローム" },
  { ticker: "7751.T", name: "キヤノン" },
  { ticker: "7741.T", name: "HOYA" },
  { ticker: "6857.T", name: "アドバンテスト" },
  { ticker: "8035.T", name: "東京エレクトロン" },
  { ticker: "6146.T", name: "ディスコ" },
  { ticker: "7733.T", name: "オリンパス" },
];

// 情報・通信・ネット
const SEC_INFOCOM: { ticker: string; name: string }[] = [
  { ticker: "9432.T", name: "日本電信電話" },
  { ticker: "9433.T", name: "KDDI" },
  { ticker: "9434.T", name: "ソフトバンク" },
  { ticker: "9984.T", name: "ソフトバンクG" },
  { ticker: "4689.T", name: "LINEヤフー" },
  { ticker: "9613.T", name: "NTTデータG" },
  { ticker: "4324.T", name: "電通グループ" },
  { ticker: "6098.T", name: "リクルートHD" },
  { ticker: "2432.T", name: "ディー・エヌ・エー" },
  { ticker: "4751.T", name: "サイバーエージェント" },
  { ticker: "4385.T", name: "メルカリ" },
  { ticker: "3659.T", name: "ネクソン" },
  { ticker: "2413.T", name: "エムスリー" },
  { ticker: "4478.T", name: "freee" },
  { ticker: "4443.T", name: "Sansan" },
  { ticker: "9766.T", name: "コナミグループ" },
  { ticker: "7832.T", name: "バンダイナムコHD" },
];

// 総合商社・卸
const SEC_TRADING: { ticker: string; name: string }[] = [
  { ticker: "8058.T", name: "三菱商事" },
  { ticker: "8031.T", name: "三井物産" },
  { ticker: "8001.T", name: "伊藤忠商事" },
  { ticker: "8053.T", name: "住友商事" },
  { ticker: "8002.T", name: "丸紅" },
  { ticker: "2768.T", name: "双日" },
  { ticker: "8015.T", name: "豊田通商" },
  { ticker: "8020.T", name: "兼松" },
];

// 医薬品・ヘルスケア
const SEC_PHARMA: { ticker: string; name: string }[] = [
  { ticker: "4502.T", name: "武田薬品工業" },
  { ticker: "4568.T", name: "第一三共" },
  { ticker: "4519.T", name: "中外製薬" },
  { ticker: "4523.T", name: "エーザイ" },
  { ticker: "4578.T", name: "大塚HD" },
  { ticker: "4503.T", name: "アステラス製薬" },
  { ticker: "4507.T", name: "塩野義製薬" },
  { ticker: "4151.T", name: "協和キリン" },
  { ticker: "4528.T", name: "小野薬品工業" },
  { ticker: "4543.T", name: "テルモ" },
  { ticker: "4901.T", name: "富士フイルムHD" },
  { ticker: "7733.T", name: "オリンパス" },
  { ticker: "2413.T", name: "エムスリー" },
  { ticker: "4587.T", name: "ペプチドリーム" },
];

// 小売・食品・生活消費
const SEC_RETAIL: { ticker: string; name: string }[] = [
  { ticker: "9983.T", name: "ファーストリテイリング" },
  { ticker: "3382.T", name: "セブン&アイ" },
  { ticker: "8267.T", name: "イオン" },
  { ticker: "7532.T", name: "パン・パシフィック(ドンキ)" },
  { ticker: "3038.T", name: "神戸物産" },
  { ticker: "9843.T", name: "ニトリHD" },
  { ticker: "8113.T", name: "ユニ・チャーム" },
  { ticker: "2914.T", name: "日本たばこ産業" },
  { ticker: "2802.T", name: "味の素" },
  { ticker: "2502.T", name: "アサヒGHD" },
  { ticker: "2503.T", name: "キリンHD" },
  { ticker: "4452.T", name: "花王" },
  { ticker: "4911.T", name: "資生堂" },
  { ticker: "2801.T", name: "キッコーマン" },
  { ticker: "3099.T", name: "三越伊勢丹HD" },
  { ticker: "8233.T", name: "高島屋" },
  { ticker: "2670.T", name: "ABCマート" },
  { ticker: "7581.T", name: "サイゼリヤ" },
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
    id: "major100",
    label: "主要100（大型・業種横断）",
    note: "大型約100本。実効ブレッドスを100級へ引き上げ、小エッジの検出力(IC t値≈IC·√breadth)を最大化。金融・素材・エネルギー・鉄道まで業種を広げた。初回取得は重いがキャッシュ後は0。",
    tickers: dedupe([...CORE30, ...EXTRA30, ...EXTRA40]),
  },
  {
    id: "sec-auto",
    label: "業種:自動車・輸送機",
    note: "同業種内で横断。市場・セクター要因が相殺され純粋な銘柄選択αが残る。β/業種中立が締まり、同業種は生存確率が近く生存者バイアスの相対影響も小さい。",
    tickers: dedupe(SEC_AUTO),
  },
  {
    id: "sec-fin",
    label: "業種:銀行・証券・保険",
    note: "金融セクター内の横断。金利・市況の共通要因を相殺し、銘柄固有の強弱だけを抽出。",
    tickers: dedupe(SEC_FIN),
  },
  {
    id: "sec-tech",
    label: "業種:電機・精密・半導体",
    note: "テック内の横断。半導体サイクル等の共通変動を落とし、個別の相対力を見る。",
    tickers: dedupe(SEC_TECH),
  },
  {
    id: "sec-infocom",
    label: "業種:情報・通信・ネット",
    note: "通信・ネット内の横断。ディフェンシブ通信と成長ネットが混在するため分散はやや大きい。",
    tickers: dedupe(SEC_INFOCOM),
  },
  {
    id: "sec-trading",
    label: "業種:総合商社・卸",
    note: "商社内の横断。銘柄数が少ない(実効ブレッドス小)ため検出力は限定的。資源・為替の共通要因は強く相殺される。",
    tickers: dedupe(SEC_TRADING),
  },
  {
    id: "sec-pharma",
    label: "業種:医薬・ヘルスケア",
    note: "医薬内の横断。パイプライン個別要因が大きく、セクター相殺後もイベント性が残りやすい。",
    tickers: dedupe(SEC_PHARMA),
  },
  {
    id: "sec-retail",
    label: "業種:小売・食品・生活消費",
    note: "内需・消費内の横断。ディフェンシブで市場βが低く、セクター相殺後の残差が扱いやすい。",
    tickers: dedupe(SEC_RETAIL),
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
