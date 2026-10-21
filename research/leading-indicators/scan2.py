"""scan.py の追検証。
 A. 多重検定: 円環シフト（X の系列を丸ごとずらす＝自己相関を保ったまま関係だけ壊す）で
    全候補×特徴の max|t| の帰無分布を作り、族補正 p を出す。
 B. 寄り付き窓(gap)の多変量モデル: 何を足すと時間外 R² が伸びるか（前進選択・拡大窓）。
 C. 1日古い情報（日本の引け時点で既知）で翌朝の窓を当てられるか（＝持ち越すか否かの判断に使えるか）。
 D. 大きく動いた日（|z|>2）の条件付き平均（非線形・閾値型の先行性）。
"""
import numpy as np, pandas as pd, os, sys
from scan import CANDS, TARGETS, jp_frame, feature, ols_t, oos_r2
import statsmodels.api as sm

HERE = os.path.dirname(os.path.abspath(__file__))
tgt = sys.argv[1] if len(sys.argv) > 1 else "mega3"
J = jp_frame(TARGETS[tgt]); J = J[J.index >= "2017-01-01"]; idx = J.index
F = {}
for lab in CANDS:
    d1, d5 = feature(lab, idx)
    F[(lab, "d1")] = d1; F[(lab, "d5")] = d5
X = pd.DataFrame(F)

def tstat_fast(y, x):
    m = ~(np.isnan(y) | np.isnan(x)); y, x = y[m], x[m]
    x = x - x.mean(); y = y - y.mean()
    b = (x @ y) / (x @ x); e = y - b * x
    # HC0
    se = np.sqrt(np.sum((x * e) ** 2)) / (x @ x)
    return b / se

print(f"### A. 族補正（円環シフト 500回） target={tgt}")
rng = np.random.default_rng(7)
for tg in ("id", "oo", "f5"):
    y = J[tg].values
    obs = {k: tstat_fast(y, X[k].values) for k in X.columns}
    if tg == "f5":  # 重複の分だけ t が膨らむ。円環シフトの帰無も同じ膨らみ方をするので族補正では相殺される
        pass
    mx = []
    n = len(y)
    for _ in range(500):
        s = rng.integers(60, n - 60)
        yy = np.roll(y, s)
        mx.append(max(abs(tstat_fast(yy, X[k].values)) for k in X.columns))
    mx = np.array(mx)
    top = sorted(obs.items(), key=lambda kv: -abs(kv[1]))[:6]
    print(f"  {tg}: 帰無 max|t| 95%点={np.quantile(mx, .95):.2f}")
    for k, t in top:
        print(f"     {k[0]:<18} {k[1]}  t={t:+.2f}  族補正p={np.mean(mx >= abs(t)):.3f}")

print(f"\n### B. 寄り付き窓(gap)の多変量・前進選択（拡大窓 OOS 2020〜） target={tgt}")
pool = [(l, "d1") for l in CANDS]
y = J["gap"]
def oos_multi(cols, start="2020-01-01", minn=500, refit=21):
    m = pd.concat([y.rename("y"), X[cols]], axis=1).dropna()
    Y = m.y.values; Z = np.column_stack([np.ones(len(m)), m[cols].values])
    st = max(np.searchsorted(m.index, np.datetime64(start)), minn)
    pred = np.full(len(m), np.nan); beta = None
    for i in range(st, len(m)):
        if beta is None or (i - st) % refit == 0:
            beta = np.linalg.lstsq(Z[:i], Y[:i], rcond=None)[0]
        pred[i] = Z[i] @ beta
    ok = ~np.isnan(pred)
    e1 = Y[ok] - pred[ok]
    return 1 - e1 @ e1 / (Y[ok] @ Y[ok])
chosen = []; best = 0
for step in range(6):
    cand = [(c, oos_multi(chosen + [c])) for c in pool if c not in chosen]
    c, r = max(cand, key=lambda kv: kv[1])
    if r - best < 0.003: break
    chosen.append(c); best = r
    print(f"  +{c[0]:<18} OOS R²={r:.3f}")
full = pd.concat([y.rename("y"), X[chosen]], axis=1).dropna()
res = sm.OLS(full.y, sm.add_constant(full[chosen])).fit(cov_type="HC3")
print(res.summary().tables[1])

print(f"\n### C. 1日古い情報 → 窓/日中（日本の引け時点で既知か） target={tgt}")
for tg in ("gap", "id"):
    rows = []
    for lab in CANDS:
        x = X[(lab, "d1")].shift(1)
        _, t, _ = ols_t(J[tg], x.rename("x"))
        rows.append((lab, t))
    rows.sort(key=lambda r: -abs(r[1]))
    print(f"  {tg}: " + ", ".join(f"{l}={t:+.1f}" for l, t in rows[:8]))

print(f"\n### D. 大きく動いた翌日（|z|>2, z は過去250日の標準偏差で基準化）→ 日中(id)・5日先(f5)の平均[bp] target={tgt}")
for lab in ["金(GC=F)", "ビットコイン(BTC)", "銅(HG=F)", "原油WTI(CL=F)", "米10年金利(^TNX)", "ドル円", "ユーロ円", "VIX", "米ハイイールド債(HYG)", "米地銀(KRE)", "MOVE(債券VIX)"]:
    x = X[(lab, "d1")]
    z = x / x.rolling(250, min_periods=120).std().shift(1)
    out = []
    for side, mask in (("急騰", z > 2), ("急落", z < -2)):
        for tg in ("id", "f5"):
            v = J[tg][mask].dropna()
            se = v.std() / np.sqrt(len(v)) if len(v) > 2 else np.nan
            out.append(f"{side}{tg}={v.mean()*1e4:+.0f}±{1.96*se*1e4:.0f}(n{len(v)})")
    print(f"  {lab:<16} " + "  ".join(out))
