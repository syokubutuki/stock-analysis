"""時間外検証: 2006-09〜2016-12（scan の期間 2017〜 より前）で同じ関係が出るか。LI_DATA=data_max で実行。"""
import numpy as np, pandas as pd, os
import scan
from scan import TARGETS, jp_frame, feature, ols_t
LONG = ["金(GC=F)", "銀(SI=F)", "銅(HG=F)", "原油WTI(CL=F)", "米10年金利(^TNX)", "米5年金利(^FVX)", "米長期債(TLT)",
        "米ハイイールド債(HYG)", "米投資適格債(LQD)", "ドル円", "ユーロ円", "豪ドル円", "米銀行株(KBE)", "米地銀(KRE)",
        "米金融(XLF)", "欧州金融(EUFN)", "VIX", "S&P500", "日経先物CME(NKD=F)", "香港ハンセン"]
for lo, hi, name in (("2006-09-01", "2016-12-31", "時間外 2006-09〜2016"), ("2017-01-01", "2026-12-31", "本検証期間 2017〜")):
    J = jp_frame(TARGETS["mega3"]); J = J[(J.index >= lo) & (J.index <= hi)]; idx = J.index
    print(f"\n=== {name}  n={len(J)} ===")
    print(f"{'候補':<16}" + "".join(f"{tg+':'+f:>11}" for tg in ("gap", "id", "oo", "f5") for f in ("d1",)) + f"{'f5:d5':>11}")
    for lab in LONG:
        d1, d5 = feature(lab, idx)
        cells = []
        for tg in ("gap", "id", "oo", "f5"):
            _, t, n = ols_t(J[tg], d1.rename("x"), 5 if tg == "f5" else 0)
            cells.append(t)
        _, t5, _ = ols_t(J["f5"], d5.rename("x"), 5)
        cells.append(t5)
        print(f"{lab:<16}" + "".join(f"{c:>11.2f}" for c in cells))
