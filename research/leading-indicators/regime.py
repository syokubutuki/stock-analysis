import numpy as np, pandas as pd
from scan import TARGETS, jp_frame, feature, ols_t, load, asof
J = jp_frame(TARGETS["mega3"]); J = J[J.index >= "2006-09-01"]; idx = J.index
vix = asof(load("^VIX").close, idx).shift(1)  # 前日判断時点のVIX水準（同時点の下落で切らない）
for lab in ["米金融(XLF)", "S&P500", "米地銀(KRE)", "米ハイイールド債(HYG)", "金(GC=F)", "銅(HG=F)", "ユーロ円", "米5年金利(^FVX)"]:
    x = feature(lab, idx)[0]
    out = []
    for nm, m in (("VIX<20", vix < 20), ("20-30", (vix >= 20) & (vix < 30)), ("≥30", vix >= 30)):
        for per, pm in (("全", idx >= "2006"), ("17〜", idx >= "2017")):
            mm = m & pm
            b, t, n = ols_t(J.id[mm], x[mm].rename("x")) if mm.sum() > 60 else (np.nan, np.nan, mm.sum())
            out.append(f"{nm}{per} t={t:+.1f}(n{mm.sum()})")
    print(f"{lab:<14} " + "  ".join(out))
