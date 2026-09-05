# `/t/[ticker]` OG画像のフォント資産

`next/og`（satori）は CJK を内蔵しない。**フォントを渡さないと日本語が豆腐になる。**
ここに置いてあるのは、そのために同梱したサブセットである。

## 出典とライセンス

| 項目 | 内容 |
|---|---|
| 書体 | Noto Sans JP（Regular 400 / Bold 700） |
| 取得元 | Google Fonts の `fonts.gstatic.com` 配信 TTF（`https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400` / `@700` が返す `.ttf`）。v56 |
| ライセンス | **SIL Open Font License 1.1**（同梱の `OFL.txt`。フォント内 name ID 14 にも `http://scripts.sil.org/OFL` が残っている） |
| 予約名 | 元の Source Han Sans 由来の Reserved Font Name は `Source`。本サブセットは `Noto Sans JP` の名前を保持しており RFN は使っていない |
| 改変 | 文字集合のサブセット化のみ（グリフ形状は無改変） |

OFL は改変・再配布を許可する（同一ライセンスでの配布が条件）。`OFL.txt` を同じ
ディレクトリに置いているのはその条件を満たすためなので、**フォントだけ移動しないこと。**

## サイズ

| ファイル | 元 | サブセット後 |
|---|---|---|
| `NotoSansJP-400.subset.ttf` | 5,324,144 B | 53,332 B（−99.0%） |
| `NotoSansJP-700.subset.ttf` | 5,319,680 B | 53,228 B（−99.0%） |

**この2本はサーバー側でしか読まれない**（satori が画像に焼くだけ）。閲覧者への転送は 0 B。
それでも絞ってあるのは、関数のコールドスタートで読む量を減らすためである。

## 収録文字（284字）

サブセットの範囲は「OG画像に出うる文字」に厳密に一致させてある。内訳は

1. `TICKER_PAGE_INSTRUMENTS` 98銘柄の `name` / `market` / `currency` / `ticker`
2. `opengraph-image.tsx` の固定文言（ラベル・ドメイン名・フォールバック文）
3. 数字・記号・英字

**この範囲外の文字が来たら豆腐になる。** そのため `charset.ts` が
`OG_FONT_CHARSET` に同じ文字列を持ち、`opengraph-image.tsx` が描画前に
`coveredByOgFont()` で被覆を検査して、外れた文字が1つでもあれば数値なしの汎用画像へ
退避する（豆腐を出さない）。**画像に描く固定文言は `charset.ts` の `OG_TEXT` に置く**
（直書きすると被覆検査の網から外れ、豆腐がそのまま焼かれる）。

→ したがって**銘柄を入れ替えたら、下の手順でサブセットを焼き直し、
`OG_FONT_CHARSET` も更新すること。**

**この同期はテストで縛ってある**（FU28・`app/lib/__tests__/og-font-charset.test.ts`）。

| 検査 | 止める壊れ方 |
|---|---|
| `TICKER_PAGE_INSTRUMENTS` の全銘柄 ⊆ `OG_FONT_CHARSET` | 銘柄を足して焼き直し忘れ → **その銘柄だけ汎用画像に退化** |
| `OG_FIXED_TEXTS` ⊆ `OG_FONT_CHARSET` | 収録外の字を含むラベル追加 → **豆腐** |
| `OG_FONT_CHARSET` = 同梱TTF2本の cmap（厳密一致） | 文字列だけ書き足してフォントを焼き直さない → **豆腐** |

**「1 だけ直す」を絶対にしないこと。** `OG_FONT_CHARSET` を広げてフォントを
焼き直さないと、フォントに無い字が「収録済み」として検査を素通りする。

## 焼き直しの手順

必要なもの: Python + `fonttools`（`pip install fonttools`）。ビルドには関与しないので
リポジトリの依存には入れない。

```bash
# 1) 元フォントを取得（v56 時点の URL。CSS から .ttf を引く）
for W in 400 700; do
  URL=$(curl -sS "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@$W" \
        | grep -oE 'https://fonts.gstatic.com/[^)]+\.ttf')
  curl -sSL -o "NotoSansJP-$W.ttf" "$URL"
done

# 2) charset.ts の OG_FONT_CHARSET をそのまま charset.txt（UTF-8）に置き、
#    コードポイント列へ変換
python -c "import io;s=io.open('charset.txt',encoding='utf-8').read();io.open('unicodes.txt','w').write(','.join('U+%04X'%ord(c) for c in s))"

# 3) サブセット化（レイアウト機能・ヒンティング・縦書きメトリクスは落とす）
for W in 400 700; do
  python -m fontTools.subset "NotoSansJP-$W.ttf" --unicodes="$(cat unicodes.txt)" \
    --output-file="NotoSansJP-$W.subset.ttf" \
    --layout-features='' --no-hinting --desubroutinize \
    --drop-tables+=DSIG,vhea,vmtx,BASE,STAT,gasp \
    --name-IDs='0,1,2,3,4,5,6,13,14'
done
```

`--layout-features=''` で GSUB/GPOS を空にしている（カーニングは落ちる）。
残すと1本あたり +25 KB になり、284字の大半が CJK である以上その分の見返りが無い。
`--name-IDs` に 13/14 を含めるのは、**ライセンス表記をフォント内に残すため**。
