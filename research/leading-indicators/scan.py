"""銀行株の短期先行指標スキャン（金・BTC・コモディティ・金利・為替・信用・海外銀行 等）。

時刻の規約（先読み防止）:
  日本の立会日 D の判断時刻は寄り付き直前。候補 X は「日付が D より厳密に小さい最新の行」(asof)。
  - 米国株/ETF/先物: 日付 D-1 の終値は JST D の朝5〜7時に確定。
  - BTC/ETH: 日付 D-1 の足は UTC 0時 = JST 9時に閉じる → 寄り付きちょうど。月曜は日曜の足（週末の動きを含む）。
  - FX: 日付 D-1 の足は London 0時 = JST 8〜9時に閉じる。
  - 香港(^HSI): D-1 の終値は JST D-1 の17時台。
  X の「1日変化」= ln X_asof(D) - ln X_asof(D-1)。日本の判断時刻どうしの間の変化（BTC の月曜は3日分）。
  利回り(^TNX 等)は水準差(%pt)。

ターゲット（日本側、D の値）:
  gap  = ln(O_D / C_{D-1})          前日終値→当日始値（X の夜間の動きと同時進行。売買はできない）
  id   = ln(C_D / O_D)               当日始値→終値（寄りで建てて引けで閉じる＝実行可能）
  oo   = ln(O_{D+1} / O_D)           始値→翌始値（デリスク研究の主ターゲット）
  f5   = ln(O_{D+5} / O_D)           始値→5営業日後始値（重複あり、NW-HAC で SE）
"""
import numpy as np, pandas as pd, os, sys, json
import statsmodels.api as sm

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, os.environ.get("LI_DATA", "data"))

def load(sym):
    f = sym.replace("^", "_").replace("=", "_")
    return pd.read_csv(os.path.join(DATA, f + ".csv"), parse_dates=["time"]).set_index("time").sort_index()

CANDS = {
    # label, ticker, kind(log|diff)
    "金(GC=F)": ("GC=F", "log"), "銀(SI=F)": ("SI=F", "log"), "銅(HG=F)": ("HG=F", "log"),
    "原油WTI(CL=F)": ("CL=F", "log"), "天然ガス(NG=F)": ("NG=F", "log"),
    "ビットコイン(BTC)": ("BTC-USD", "log"), "イーサリアム(ETH)": ("ETH-USD", "log"),
    "米10年金利(^TNX)": ("^TNX", "diff"), "米5年金利(^FVX)": ("^FVX", "diff"),
    "米3か月金利(^IRX)": ("^IRX", "diff"), "米30年金利(^TYX)": ("^TYX", "diff"),
    "米長期債(TLT)": ("TLT", "log"), "米ハイイールド債(HYG)": ("HYG", "log"), "米投資適格債(LQD)": ("LQD", "log"),
    "ドル円": ("USDJPY=X", "log"), "ユーロ円": ("EURJPY=X", "log"), "豪ドル円": ("AUDJPY=X", "log"),
    "ドル指数(DXY)": ("DX-Y.NYB", "log"),
    "米銀行株(KBE)": ("KBE", "log"), "米地銀(KRE)": ("KRE", "log"), "米金融(XLF)": ("XLF", "log"),
    "欧州金融(EUFN)": ("EUFN", "log"), "JPモルガン": ("JPM", "log"),
    "VIX": ("^VIX", "log"), "MOVE(債券VIX)": ("^MOVE", "log"),
    "S&P500": ("^GSPC", "log"), "日経先物CME(NKD=F)": ("NKD=F", "log"),
    "香港ハンセン": ("^HSI", "log"), "上海総合": ("000001.SS", "log"), "ユーロストックス50": ("^STOXX50E", "log"),
}

TARGETS = {"mega3": ["8306.T", "8316.T", "8411.T"], "1615.T": ["1615.T"],
           "8306.T": ["8306.T"], "8316.T": ["8316.T"], "8411.T": ["8411.T"],
           "regional5": ["8331.T", "8354.T", "7186.T", "5831.T", "8309.T"]}


def asof(series, idx):
    s = series.dropna()
    pos = s.index.searchsorted(idx, side="left") - 1
    v = np.where(pos >= 0, s.values[np.clip(pos, 0, None)], np.nan)
    return pd.Series(v, index=idx)


def jp_frame(tickers):
    gs, ids, cs = [], [], []
    for t in tickers:
        a = load(t)
        a = a[(a.volume > 0) | (a.index < "2000-01-01")]  # 出来高0の行(幻の行の残り)を除く
        gs.append(np.log(a.open / a.close.shift(1)).rename(t))
        ids.append(np.log(a.close / a.open).rename(t))
        cs.append(np.log(a.open).rename(t))
    gap = pd.concat(gs, axis=1).mean(axis=1)
    idr = pd.concat(ids, axis=1).mean(axis=1)
    lo = pd.concat(cs, axis=1)
    oo = (lo.shift(-1) - lo).mean(axis=1)
    f5 = (lo.shift(-5) - lo).mean(axis=1)
    df = pd.DataFrame({"gap": gap, "id": idr, "oo": oo, "f5": f5}).dropna(subset=["gap", "id"])
    df["cc_prev"] = (df.gap + df.id).shift(1)
    return df


def feature(label, idx):
    t, kind = CANDS[label]
    a = load(t).close
    lv = asof(np.log(a) if kind == "log" else a, idx)
    d1 = lv - lv.shift(1)
    d5 = lv - lv.shift(5)
    return d1, d5


def ols_t(y, X, hac=0):
    m = pd.concat([y, X], axis=1).dropna()
    if len(m) < 200:
        return np.nan, np.nan, len(m)
    Xc = sm.add_constant(m.iloc[:, 1:])
    r = sm.OLS(m.iloc[:, 0], Xc).fit(cov_type="HAC", cov_kwds={"maxlags": hac}) if hac else \
        sm.OLS(m.iloc[:, 0], Xc).fit(cov_type="HC3")
    return r.params.iloc[1], r.tvalues.iloc[1], len(m)


def oos_r2(y, x, start="2020-01-01", minn=500):
    """拡大窓の単回帰で1期先を予測。ベンチマークは予測0（ドリフトなし）。R²_oos = 1 - SSE/SST0"""
    m = pd.concat([y.rename("y"), x.rename("x")], axis=1).dropna()
    yy, xx = m.y.values, m.x.values
    idx = m.index
    pred = np.full(len(m), np.nan)
    st = np.searchsorted(idx, np.datetime64(start))
    # 累積和で高速な拡大窓 OLS
    cx, cy, cxx, cxy = np.cumsum(xx), np.cumsum(yy), np.cumsum(xx * xx), np.cumsum(xx * yy)
    for i in range(max(st, minn), len(m)):
        n = i
        sx, sy, sxx, sxy = cx[i - 1], cy[i - 1], cxx[i - 1], cxy[i - 1]
        var = sxx - sx * sx / n
        b = (sxy - sx * sy / n) / var if var > 0 else 0.0
        a0 = sy / n - b * sx / n
        pred[i] = a0 + b * xx[i]
    ok = ~np.isnan(pred)
    e1 = yy[ok] - pred[ok]
    e0 = yy[ok]
    return 1 - (e1 @ e1) / (e0 @ e0), (np.sign(pred[ok]) == np.sign(yy[ok])).mean(), ok.sum()


def year_signs(y, x):
    m = pd.concat([y.rename("y"), x.rename("x")], axis=1).dropna()
    g = m.groupby(m.index.year).apply(lambda d: d.x.corr(d.y) if len(d) > 60 else np.nan).dropna()
    return g


def run(target="mega3"):
    J = jp_frame(TARGETS[target])
    idx = J.index
    J = J[idx >= "2017-01-01"]
    idx = J.index
    spx1, _ = feature("S&P500", idx)
    nkd1, _ = feature("日経先物CME(NKD=F)", idx)
    rows = []
    for lab in CANDS:
        d1, d5 = feature(lab, idx)
        for fname, x in (("d1", d1), ("d5", d5)):
            for tg in ("gap", "id", "oo", "f5"):
                y = J[tg]
                hac = 5 if tg == "f5" else 0
                ic = pd.concat([y, x], axis=1).dropna().corr(method="spearman").iloc[0, 1]
                b, t, n = ols_t(y, x.rename("x"), hac)
                # 対照: 米国株(S&P)と日経先物を入れても残るか
                ctrl = pd.concat([x.rename("x"), spx1.rename("spx"), nkd1.rename("nkd")], axis=1)
                if lab in ("S&P500",):
                    ctrl = ctrl[["x", "nkd"]]
                if lab.startswith("日経先物"):
                    ctrl = ctrl[["x", "spx"]]
                _, tc, _ = ols_t(y, ctrl, hac)
                r2o, hit, no = oos_r2(y, x) if tg != "f5" else (np.nan, np.nan, 0)
                ys = year_signs(y, x)
                rows.append(dict(cand=lab, feat=fname, target=tg, n=n, ic=ic, beta=b, t=t, t_ctrl=tc,
                                 r2_oos=r2o, hit=hit, yrs_pos=(ys > 0).sum(), yrs=len(ys),
                                 first=ys[ys.index <= 2021].mean(), second=ys[ys.index > 2021].mean()))
    R = pd.DataFrame(rows)
    return R, J


if __name__ == "__main__":
    tgt = sys.argv[1] if len(sys.argv) > 1 else "mega3"
    R, J = run(tgt)
    R.to_csv(os.path.join(HERE, f"scan_{tgt}.csv"), index=False)
    pd.set_option("display.width", 250, "display.max_rows", 500)
    for tg in ("gap", "id", "oo", "f5"):
        print(f"\n===== target={tg}  ({tgt}, n={len(J)}) =====")
        S = R[R.target == tg].copy()
        S["abs_t"] = S.t.abs()
        print(S.sort_values("abs_t", ascending=False).head(18)[
            ["cand", "feat", "n", "ic", "t", "t_ctrl", "r2_oos", "hit", "yrs_pos", "yrs", "first", "second"]].round(3).to_string(index=False))
