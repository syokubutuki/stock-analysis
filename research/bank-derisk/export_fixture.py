"""stress-hyst 規則の黄金値フィクスチャを書き出す（docs/derisk-rule-design.md §4.2）。

意図的に common.py を import しない。common.py が変わるとフィクスチャが黙って変わるのを避けるため、
設計書 §2.3 の式をここで独立に書く。入力は data_max（2000年〜、repairPriceGlitches 通過済み）を
2018-01-01 以降に切り、価格を小数6桁に丸めてから計算する（TS 側は丸めた値を読む）。

使い方: python export_fixture.py  → ../../app/lib/__tests__/fixtures/derisk-golden.json
"""
import json, os, math
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data_max")
OUT = os.path.join(HERE, "..", "..", "app", "lib", "__tests__", "fixtures", "derisk-golden.json")
START = "2018-01-01"
TICKER = "8306.T"
P = dict(vixRatio=1.25, volRatio=1.8, dd60=-0.12, kreDd60=-0.12, kIn=2, calmN=5, kOut=0)
COST = 0.0005
ANN = 245


def load(sym):
    f = sym.replace("^", "_").replace("=", "_")
    d = pd.read_csv(os.path.join(DATA, f + ".csv"), parse_dates=["time"]).set_index("time").sort_index()
    d = d[d.index >= START]
    return d.round(6)


def g(x, digits=10):
    """TS の golden() と同じ丸め（有効桁）。NaN/inf はそのまま。"""
    if x is None or (isinstance(x, float) and not math.isfinite(x)):
        return None if x is None or math.isnan(x) else x
    if x == 0:
        return 0
    return float(f"{x:.{digits}g}")


def asof(s, idx):
    s = s.dropna()
    pos = s.index.searchsorted(idx, side="left") - 1
    vals = np.where(pos >= 0, s.values[np.clip(pos, 0, None)], np.nan)
    dates = np.where(pos >= 0, s.index.values[np.clip(pos, 0, None)], np.datetime64("NaT"))
    return pd.Series(vals, index=idx), pd.Series(dates, index=idx)


a = load(TICKER); v = load("^VIX"); k = load("KRE")
idx = a.index
# --- 日本側（shift(1)：行 t は t−1 までの終値だけ） ---
lc = np.log(a.close); r = lc.diff()
vol5 = r.rolling(5).std().shift(1); vol60 = r.rolling(60).std().shift(1)
volratio = vol5 / vol60
dd60 = (a.close / a.close.rolling(60, min_periods=20).max() - 1).shift(1)
# --- 米国側（米国の暦で派生量を作ってから asof） ---
vix_ratio, vix_date = asof(v.close / v.close.rolling(20).mean(), idx)
kre_dd, kre_date = asof(k.close / k.close.rolling(60).max() - 1, idx)
y_oo = np.log(a.open.shift(-1) / a.open)

F = pd.DataFrame(dict(vixRatio=vix_ratio, volRatio=volratio, dd60=dd60, kreDd60=kre_dd, y=y_oo), index=idx)
valid = F.dropna(subset=["vixRatio", "volRatio", "dd60", "kreDd60"])
stress = ((valid.vixRatio > P["vixRatio"]).astype(int) + (valid.volRatio > P["volRatio"]).astype(int)
          + (valid.dd60 < P["dd60"]).astype(int) + (valid.kreDd60 < P["kreDd60"]).astype(int)).values

w = np.ones(len(stress)); cur = 1; calm = 0
for i in range(len(stress)):
    if cur == 1:
        if stress[i] >= P["kIn"]: cur = 0; calm = 0
    else:
        calm = calm + 1 if stress[i] <= P["kOut"] else 0
        if calm >= P["calmN"]: cur = 1
    w[i] = cur
valid = valid.assign(stress=stress, w=w)

ev = valid.dropna(subset=["y"])


def metrics(net, w):
    n = len(net); yrs = n / ANN
    eq = net.cumsum(); mdd = float((np.exp(eq) / np.exp(eq).cummax() - 1).min())
    sd = float(net.std())
    return dict(
        nDays=n, cagr=g(math.exp(net.sum() / yrs) - 1), vol=g(sd * math.sqrt(ANN)),
        sharpe=g(float(net.mean()) / sd * math.sqrt(ANN)) if sd > 0 else None,
        maxDrawdown=g(mdd), inMarket=g(float(w.mean())), turnover=g(float(w.diff().abs().sum()) / yrs),
        total=g(math.exp(net.sum()) - 1),
    )


def net_ret(w, y, c):
    dw = w.diff().abs().fillna(w.abs())
    return w * y - c * dw


wE = ev.w; yE = ev.y
rule = metrics(net_ret(wE, yE, COST), wE)
bh = metrics(yE, pd.Series(1.0, index=ev.index))
cost_sens = [dict(costBp=bp, rule=metrics(net_ret(wE, yE, bp / 1e4), wE)) for bp in (0, 5, 10, 20)]
ERAS = [("2006-09〜2009", "2006-09-01", "2009-12-31"), ("2010〜2012", "2010-01-01", "2012-12-31"),
        ("2013〜2017", "2013-01-01", "2017-12-31"), ("2018〜", "2018-01-01", None)]
by_era = []
for label, a_, b_ in ERAS:
    m = (ev.index >= a_) & ((ev.index <= b_) if b_ else True)
    if m.sum() == 0:
        by_era.append(dict(label=label, rule=None, buyHold=None)); continue
    by_era.append(dict(label=label, rule=metrics(net_ret(wE[m], yE[m], COST), wE[m]),
                       buyHold=metrics(yE[m], pd.Series(1.0, index=ev.index[m]))))

episodes = []
i = 0; wv = valid.w.values; keys = ["vixRatio", "volRatio", "dd60", "kreDd60"]
while i < len(wv):
    if wv[i] != 0: i += 1; continue
    j = i; s = 0.0; nn = 0
    while j < len(wv) and wv[j] == 0:
        yy = valid.y.values[j]
        if not np.isnan(yy): s += yy; nn += 1
        j += 1
    row = valid.iloc[i]
    lit = [kk for kk, on in zip(keys, [row.vixRatio > P["vixRatio"], row.volRatio > P["volRatio"], row.dd60 < P["dd60"], row.kreDd60 < P["kreDd60"]]) if on]
    episodes.append(dict(start=str(valid.index[i].date()), end=str(valid.index[j - 1].date()) if j < len(wv) else None,
                         days=j - i, litAtEntry=lit, bhReturn=g(math.exp(s) - 1) if nn > 0 else None))
    i = j

fx = dict(
    meta=dict(generator="research/bank-derisk/export_fixture.py", source="data_max (fetch_max.mts, repairPriceGlitches)",
              ticker=TICKER, start=START, lastTime=str(idx[-1].date()), note="prices rounded to 6 decimals before computing"),
    params=P, costOneWay=COST,
    target=[dict(time=str(t.date()), open=float(o), close=float(c)) for t, o, c in zip(a.index, a.open, a.close)],
    vix=[dict(time=str(t.date()), close=float(c)) for t, c in zip(v.index, v.close)],
    kre=[dict(time=str(t.date()), close=float(c)) for t, c in zip(k.index, k.close)],
    expected=dict(
        historyStart=str(valid.index[0].date()),
        rows=[dict(time=str(t.date()), stress=int(s), w=int(ww)) for t, s, ww in zip(valid.index, valid.stress, valid.w)],
        latest=dict(time=str(valid.index[-1].date()), stress=int(valid.stress.iloc[-1]), holding=bool(valid.w.iloc[-1] == 1),
                    vixRatio=g(float(valid.vixRatio.iloc[-1])), volRatio=g(float(valid.volRatio.iloc[-1])),
                    dd60=g(float(valid.dd60.iloc[-1])), kreDd60=g(float(valid.kreDd60.iloc[-1])),
                    vixAsOf=str(pd.Timestamp(vix_date.loc[valid.index[-1]]).date()), kreAsOf=str(pd.Timestamp(kre_date.loc[valid.index[-1]]).date())),
        metrics=dict(rule=rule, buyHold=bh), costSensitivity=cost_sens, byEra=by_era, episodes=episodes,
        nEval=int(len(ev)),
    ),
)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(fx, f, ensure_ascii=False, separators=(",", ":"))
print("wrote", os.path.normpath(OUT), "rows", len(valid), "eval", len(ev), "episodes", len(episodes))
print("rule", rule); print("bh", bh); print("latest", fx["expected"]["latest"])
