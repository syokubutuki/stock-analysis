import numpy as np, pandas as pd
from scan import TARGETS, jp_frame, feature, ols_t, load
J = jp_frame(TARGETS["mega3"]); J = J[J.index >= "2006-09-01"]; idx = J.index
labs = ["米金融(XLF)", "S&P500", "米ハイイールド債(HYG)", "ユーロ円", "銅(HG=F)", "米5年金利(^FVX)", "金(GC=F)", "日経先物CME(NKD=F)"]
X = {l: feature(l, idx)[0] for l in labs}
print("年   " + "".join(f"{l[:7]:>10}" for l in labs) + "   | gap~XLF   open=prevclose率")
a = load("8306.T")
for y in range(2007, 2027):
    m = J.index.year == y
    row = []
    for l in labs:
        _, t, _ = ols_t(J.id[m], X[l][m].rename("x")) if m.sum() > 200 else (0, np.nan, 0)
        row.append(t)
    _, tg, _ = ols_t(J.gap[m], X["米金融(XLF)"][m].rename("x"))
    aa = a[a.index.year == y]
    same = (np.abs(aa.open / aa.close.shift(1) - 1) < 1e-9).mean()
    print(f"{y} " + "".join(f"{t:>10.2f}" for t in row) + f"   | {tg:7.2f}   {same:.2f}")
