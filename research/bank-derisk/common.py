"""銀行株デリスク研究 共通基盤。

規約: 判断は「JST 朝7時」。行 t = 日本の立会日 t。
 - 日本側の特徴量は t-1 までの確定値(終値/始値)だけ。t の始値はまだ出ていない。
 - 米国/VIX/金利/為替は「日付が t より厳密に小さい最新の行」(asof)。米国の終値は JST 翌朝5-6時に確定。
 - ターゲット: y_oo = ln(open[t+1]/open[t]) (始値で建て次の始値まで保有)。
              y_id = ln(close[t]/open[t]) (日中のみ)、y_on = ln(open[t+1]/close[t]) (夜間)。
"""
import numpy as np, pandas as pd, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, os.environ.get("BD_DATA", "data"))


def load(sym):
    f = sym.replace("^", "_").replace("=", "_")
    return pd.read_csv(os.path.join(DATA, f + ".csv"), parse_dates=["time"]).set_index("time").sort_index()


def asof_us(series, jp_index, lag_strict=True):
    """日付が jp_index の各日より厳密に小さい最新値を返す。"""
    s = series.dropna()
    idx = s.index
    pos = idx.searchsorted(jp_index, side="left") - 1  # < t
    out = pd.Series(np.where(pos >= 0, s.values[np.clip(pos, 0, None)], np.nan), index=jp_index)
    return out


def rolling_dd(c, n):
    return c / c.rolling(n, min_periods=max(5, n // 3)).max() - 1


def build(asset="1615.T", extra=True):
    a = load(asset)
    idx = a.index
    o, c, h, l = a.open, a.close, a.high, a.low
    lc = np.log(c)
    r = lc.diff()                       # close-to-close
    gap = np.log(o / c.shift(1))        # 前日終値→当日始値
    idr = np.log(c / o)                 # 日中
    F = pd.DataFrame(index=idx)
    # --- 日本側: すべて shift(1) で t-1 までに限る ---
    for n in (1, 3, 5, 10, 20, 60):
        F[f"ret{n}"] = (lc - lc.shift(n)).shift(1)
    for n in (20, 60, 120, 252):
        F[f"dd{n}"] = rolling_dd(c, n).shift(1)
    for n in (20, 50, 200):
        F[f"sma{n}"] = (lc - np.log(c.rolling(n).mean())).shift(1)
    for n in (5, 20, 60):
        F[f"vol{n}"] = r.rolling(n).std().shift(1)
    F["volratio"] = F.vol5 / F.vol60
    F["downvol20"] = r.where(r < 0, 0).pow(2).rolling(20).mean().pow(0.5).shift(1)
    F["parkinson20"] = (np.log(h / l) ** 2 / (4 * np.log(2))).rolling(20).mean().pow(0.5).shift(1)
    F["negdays10"] = (r < 0).rolling(10).sum().shift(1)
    F["maxdrop20"] = r.rolling(20).min().shift(1)
    F["gap_prev"] = gap.shift(1)
    F["id_prev"] = idr.shift(1)
    F["gap5"] = gap.rolling(5).sum().shift(1)
    F["id5"] = idr.rolling(5).sum().shift(1)
    if extra:
        t = load("1306.T"); tc = np.log(t.close.reindex(idx).ffill())
        F["topix_ret1"] = (tc - tc.shift(1)).shift(1)
        F["topix_ret5"] = (tc - tc.shift(5)).shift(1)
        F["topix_ret20"] = (tc - tc.shift(20)).shift(1)
        F["rel20"] = F.ret20 - F.topix_ret20
        F["topix_dd60"] = rolling_dd(t.close.reindex(idx).ffill(), 60).shift(1)
        F["topix_vol20"] = tc.diff().rolling(20).std().shift(1)
        n225 = load("^N225"); nc = np.log(n225.close.reindex(idx).ffill())
        F["n225_ret1"] = (nc - nc.shift(1)).shift(1)
        # --- 米国/グローバル (asof, strictly earlier date) ---
        def us(sym, name, lags=(1, 5, 20), dd=None, level=False, diff=False):
            d = load(sym).close
            ld = np.log(d) if not diff else d
            for n in lags:
                s = (ld - ld.shift(n))
                F[f"{name}_ret{n}"] = asof_us(s, idx)
            if dd:
                F[f"{name}_dd{dd}"] = asof_us(d / d.rolling(dd).max() - 1, idx)
            if level:
                F[f"{name}_lvl"] = asof_us(d, idx)
        us("^GSPC", "sp", dd=60)
        us("^IXIC", "nq", lags=(1,))
        us("^SOX", "sox", lags=(1,))
        us("KRE", "kre", dd=60)
        us("XLF", "xlf", lags=(1, 5))
        us("USDJPY=X", "fx", lags=(1, 5, 20))
        us("^TNX", "tnx", lags=(1, 5, 20), level=True, diff=True)
        v = load("^VIX").close
        F["vix"] = asof_us(v, idx)
        F["vix_chg1"] = asof_us(v.pct_change(), idx)
        F["vix_chg5"] = asof_us(v.pct_change(5), idx)
        F["vix_z60"] = asof_us((v - v.rolling(60).mean()) / v.rolling(60).std(), idx)
        F["vix_ma_ratio"] = asof_us(v / v.rolling(20).mean(), idx)
        F["kre_rel20"] = F.kre_ret20 - F.sp_ret20
    # --- カレンダー ---
    F["dow"] = idx.dayofweek
    F["month"] = idx.month
    F["exdiv"] = ((idx.month.isin([3, 9])) & (idx.day >= 20)).astype(int)
    # --- ターゲット ---
    T = pd.DataFrame(index=idx)
    T["y_oo"] = np.log(o.shift(-1) / o)
    T["y_id"] = np.log(c / o)
    T["y_on"] = np.log(o.shift(-1) / c)
    T["y_cc"] = np.log(c.shift(-1) / c)
    return F, T


def perf(w, y, cost=0.0005, ann=245):
    """w: 当日建玉(0..1) y: 当日保有リターン(対数)。コスト=片道×|Δw|。"""
    w = pd.Series(w, index=y.index).astype(float)
    dw = w.diff().abs().fillna(w.abs())
    net = w * y - cost * dw
    eq = net.cumsum()
    n = net.notna().sum()
    yrs = n / ann
    cagr = np.exp(net.sum() / yrs) - 1
    vol = net.std() * np.sqrt(ann)
    sharpe = net.mean() / net.std() * np.sqrt(ann) if net.std() > 0 else np.nan
    dd = (np.exp(eq) / np.exp(eq).cummax() - 1).min()
    return dict(cagr=cagr, vol=vol, sharpe=sharpe, maxdd=dd, calmar=(cagr / -dd) if dd < 0 else np.nan,
                inmkt=w.mean(), turn=dw.sum() / yrs, tot=np.exp(net.sum()) - 1)


def fmt(d):
    return (f"CAGR {d['cagr']*100:6.1f}% vol {d['vol']*100:5.1f}% Sh {d['sharpe']:5.2f} "
            f"MDD {d['maxdd']*100:6.1f}% Calmar {d['calmar']:5.2f} inMkt {d['inmkt']*100:4.0f}% turn {d['turn']:5.1f}x/y")
