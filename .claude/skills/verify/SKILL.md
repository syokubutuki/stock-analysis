---
name: verify
description: このリポジトリの分析コンポーネントを実際にブラウザで動かして確認する手順。チャートが描画・計算されるかを目で見る。
---

# 分析コンポーネントの実動確認

分析はすべて `next/dynamic` の SSR無効クライアントコンポーネントなので、**HTMLを取得しても中身は空**。
必ずブラウザで駆動して観測する。型チェックやテストは検証ではない。

## 手元にあるもの / ないもの

- Playwright/Puppeteer は**未導入**（入れないこと。`package.json` を汚す）
- Edge は入っている: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
- → スクラッチパッドに `playwright-core` だけ入れて、既存Edgeを `executablePath` で叩く

```powershell
$s = "<scratchpad>"
npm install --prefix $s playwright-core --no-save   # ブラウザDLなし、リポジトリ非汚染
$env:NODE_PATH = "$s\node_modules"
```

## 起動

```powershell
npx next dev -p 3100      # 既定3000は他セッションが使っている可能性あり。別ポートに逃がす
```

Turbopackで ~2秒で Ready。型エラーがあっても dev は起動する（トランスパイルのみ）ので、
他人の作業中コードが赤くても自分の画面は確認できることが多い。

## 駆動

パネルは折りたたみ（`CollapsibleAnalysis`）。**開閉状態は `localStorage` の `sa:open:<分析ID>`**
なので、`addInitScript` で先に "1" を入れておけば開いた状態でマウントされる（クリック不要）。

```js
await ctx.addInitScript((id) => localStorage.setItem(`sa:open:${id}`, "1"), "cal-today-vs-expected");
await page.goto("http://localhost:3100");
await page.getByPlaceholder(/銘柄|コード|検索/).first().fill("7203.T");
await page.keyboard.press("Enter");
await page.getByRole("button", { name: "カレンダー", exact: true }).waitFor({ timeout: 60000 });
await page.getByRole("button", { name: "カレンダー", exact: true }).click();
const panel = page.locator("#panel-cal-today-vs-expected");   // section id = panel-<分析ID>
await panel.locator("canvas").first().waitFor({ timeout: 90000 });
```

- 分析IDは `app/page.tsx` の各セクションの `items[].id`
- セクションタブのラベルは `app/page.tsx` の `SECTIONS`（カレンダー/リスク指標/…）
- データ取得は Yahoo 実API（`/api/stock`）。ネットワーク必須、日中足は取得に数秒〜十数秒
- 待つのは canvas の出現 + 2〜3秒（fetch → useMemo計算 → useEffect描画）

## 観測

- `panel.innerText()` が一番強い証拠。表・バナー・統計値がそのまま取れる
- Canvas が「描かれているか」は `getImageData` で非背景ピクセル数を数える（背景は `#fafafa` = 250,250,250）
- `page.on("pageerror")` と console error を必ず拾う
- `panel.screenshot({ path })` でパネル単体を撮る（ページ全体だと巨大）

## 叩きどころ（このプロジェクト特有）

- **標本を薄くする**: 米国ビンを5分位、条件を絞る → `n` が減って回帰が落ちる境界を見る。
  `StatBadge` は n<30 で「参考(n小)」に落ちるのが正常
- **条件を緩める**: 「無条件」でフル標本（60分足で n≈726 ≒ 3年ぶん取れる。
  `IntradayCaveat` の「60分足≈2年」は実態より控えめ）
- **足を変える**: 5/15/30分足は履歴≈60日しかないので、層別すると即座に標本不足になる
- **対象日を過去に振る**: 先読み排除トグルがあるものは n が減るのが正しい挙動
