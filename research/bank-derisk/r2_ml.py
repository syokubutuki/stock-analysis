from wf import *
import sys, pickle
assets=["8306.T","8316.T","8411.T","1615.T"]
RES={}
def zexp(s):
    m=s.expanding(60).mean().shift(1); sd=s.expanding(60).std().shift(1)
    return (s-m)/sd
for a in assets:
    D,feats=dataset(a)
    P=walk_forward(D,feats,"y_oo")
    Z=P.apply(zexp)
    P["ens_all"]=Z[["ridge","logit","lgb_reg","lgb_clf"]].mean(axis=1)
    P["ens_lgb"]=Z[["lgb_reg","lgb_clf"]].mean(axis=1)
    P["ens_lin"]=Z[["ridge","logit"]].mean(axis=1)
    RES[a]=(D,P)
pickle.dump(RES,open("r2_preds.pkl","wb"))
y_all={}
for a,(D,P) in RES.items():
    y=D.y_oo.reindex(P.index)
    ok=y.notna()
    bh=perf(np.ones(ok.sum()),y[ok])
    print(f"\n=== {a}  OOS {P.index[0].date()}..{P.index[-1].date()} n={ok.sum()}")
    print(f"{'B&H':22s}",fmt(bh))
    from scipy.stats import spearmanr
    for m in P.columns:
        s=P[m][ok]; ic=spearmanr(s.dropna(),y[ok][s.notna()])[0]
        line=[f"IC={ic:+.3f}"]
        for q in (0.2,0.35):
            w=to_weights_by_quantile(P[m][ok],q)
            n=net_ret(w,y[ok]); p=perf(w,y[ok])
            al,t,b=alpha_vs_bh(n,y[ok])
            line.append(f"q{int(q*100)}: Sh {p['sharpe']:.2f} CAGR {p['cagr']*100:5.1f}% MDD {p['maxdd']*100:5.1f}% inMkt {p['inmkt']*100:3.0f}% turn {p['turn']:4.0f} α {al*100:+5.1f}% (t={t:+.1f})")
        print(f"{m:10s}"," | ".join(line))
