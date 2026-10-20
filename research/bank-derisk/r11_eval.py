import os; os.environ["BD_DATA"]="data_max"
from wf import *
from r3_kelly import kelly_w
from r8_slowml import weights_from_p
from r4_ablate import summ
import pickle
OUT=pickle.load(open("r10_all.pkl","rb"))
def era_table(n,y,w,eras=(("2012-2017","2012-01-01","2017-12-31"),("2018-2026","2018-01-01","2026-12-31"))):
    for nm,s,e in eras:
        m=(n.index>=s)&(n.index<=e)
        print(f"     {nm}: {summ(n[m],y[m],w[m])}")
def basket(fn,cost=0.0005):
    ns,ys,ws=[],[],[]
    for a,(D,P,V,S) in OUT.items():
        w,yo=fn(a,D,P,V,S); ok=yo.notna()
        ns.append(net_ret(w[ok],yo[ok],cost)); ys.append(yo[ok]); ws.append(w[ok])
    return pd.concat(ns,axis=1).mean(axis=1),pd.concat(ys,axis=1).mean(axis=1),pd.concat(ws,axis=1).mean(axis=1)
def y_of(D,P): return D.y_oo.reindex(P.index)
if __name__=="__main__":
    from scipy.stats import spearmanr
    # 1) 日次IC
    for m in OUT["8306.T"][1].columns:
        ics=[spearmanr(P[m].dropna(),y_of(D,P)[P[m].notna()],nan_policy="omit")[0] for a,(D,P,V,S) in OUT.items()]
        print(f"日次IC {m:8s}", np.round(ics,3))
    n,y,w=basket(lambda a,D,P,V,S:(pd.Series(1.0,index=P.index),y_of(D,P)))
    print("\nB&H           :",summ(y,y,w)); era_table(y,y,w)
    mu_bar=lambda D,P: D.y_oo.expanding(250).mean().shift(3).reindex(P.index)
    for lam,kap in ((2,1.0),(2,0.5),(4,1.0)):
        for cost in (0.0005,0.001):
            fn=lambda a,D,P,V,S:(kelly_w(P[["ridge","lgb_reg"]].mean(axis=1),V,lam,kap,mu_bar(D,P)).fillna(1.0),y_of(D,P))
            n,y,w=basket(fn,cost); print(f"\nKelly lam={lam} kappa={kap} cost={cost*1e4:.0f}bp:",summ(n,y,w))
            if cost==0.0005: era_table(n,y,w)
    # vol only
    fn=lambda a,D,P,V,S:((mu_bar(D,P)/(2*V)).clip(0,1).fillna(1.0),y_of(D,P)); n,y,w=basket(fn); print("\nVOL-only lam=2:",summ(n,y,w)); era_table(n,y,w)
    # 2) スロー: 暴落確率→建玉
    for m in ("logit","lgb","ens"):
        fn=lambda a,D,P,V,S:(weights_from_p(S[m],0.5,0.95,1),y_of(D,P)); n,y,w=basket(fn); print(f"\nSlow-{m} (lo.5/hi.95):",summ(n,y,w)); era_table(n,y,w)
