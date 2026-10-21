import numpy as np, pandas as pd, statsmodels.api as sm
from scan import TARGETS, jp_frame, feature, load, asof
J = jp_frame(TARGETS["mega3"]); J = J[J.index >= "2006-09-01"]; idx = J.index
vix = asof(load("^VIX").close, idx).shift(1)
def t_(y, x):
    m = pd.concat([y, x], axis=1).dropna(); r = sm.OLS(m.iloc[:,0], sm.add_constant(m.iloc[:,1])).fit(cov_type="HC3"); return r.params.iloc[1], r.tvalues.iloc[1], len(m)
for lab in ["米金融(XLF)", "米地銀(KRE)", "S&P500", "ユーロ円", "米ハイイールド債(HYG)", "金(GC=F)"]:
    x = feature(lab, idx)[0]
    s = []
    for per, pm in (("2008-09", (idx>="2008-01")&(idx<"2010-01")), ("2010-16", (idx>="2010-01")&(idx<"2017-01")), ("2017-", idx>="2017-01")):
        mm = (vix >= 30) & pm
        if mm.sum() > 30:
            b, t, n = t_(J.id[mm], x[mm]); s.append(f"{per}: β={b:+.2f} t={t:+.1f} n={n}")
        else: s.append(f"{per}: n={mm.sum()}")
    print(f"{lab:<14} VIX≥30 → " + " | ".join(s))
print((vix>=30).groupby(idx.year).sum().to_dict())
