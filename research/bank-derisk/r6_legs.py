from wf import *
from r3_kelly import vol_wf
import pickle
def legs_eval(asset, q, cost, volk=None, cache={}):
    D,feats=dataset(asset)
    k=(asset,"idpred")
    if k not in cache:
        P=walk_forward(D,feats,"y_id",models={m:f for m,f in make_models().items() if m in("ridge","lgb_reg")})
        cache[k]=P[["ridge","lgb_reg"]].mean(axis=1)
    mu=cache[k]
    idx=mu.index
    y_id=D.y_id.reindex(idx); y_on=D.y_on.reindex(idx); ok=y_id.notna()&y_on.notna()
    mu,y_id,y_on=mu[ok],y_id[ok],y_on[ok]
    w_id=to_weights_by_quantile(mu,q) if q>0 else pd.Series(1.0,index=mu.index)
    if volk:
        va=D.vol20.reindex(mu.index)*np.sqrt(245); w_on=(volk/va).clip(upper=1).fillna(1)
    else: w_on=pd.Series(1.0,index=mu.index)
    # 日次リターン: 夜間は w_on(前日終値時点の建玉でなく当日終値で保有する量) / 日中は w_id
    ret=w_id*y_id + w_on*y_on
    # コスト: 日中外す日は 始値で売り(1-w_id) + 終値で買戻し(1-w_id) ; 夜間建玉変更は |Δw_on|
    c=cost*(2*(1-w_id)) + cost*w_on.diff().abs().fillna(0)
    net=ret-c
    bh=y_id+y_on
    return net,bh,w_id,w_on
def summ2(n,bh,w):
    yrs=len(n)/245; eq=n.cumsum(); dd=(np.exp(eq)/np.exp(eq).cummax()-1).min()
    al,t,b=alpha_vs_bh(n,bh)
    return f"CAGR {(np.exp(n.sum()/yrs)-1)*100:5.1f}% vol {n.std()*np.sqrt(245)*100:4.1f}% Sh {n.mean()/n.std()*np.sqrt(245):4.2f} MDD {dd*100:5.1f}% idle日中 {(1-w).mean()*100:3.0f}% α {al*100:+5.1f}% (t={t:+.1f}) β={b:.2f}"
if __name__=="__main__":
    assets=["8306.T","8316.T","8411.T"]
    for volk in (None,0.30):
        for q in (0.15,0.25,0.4):
            for cost in (0.0005,0.001):
                ns,bs,ws=[],[],[]
                for a in assets:
                    n,bh,w_id,w_on=legs_eval(a,q,cost,volk); ns.append(n); bs.append(bh); ws.append(w_id)
                n=pd.concat(ns,axis=1).mean(axis=1); bh=pd.concat(bs,axis=1).mean(axis=1); w=pd.concat(ws,axis=1).mean(axis=1)
                print(f"volk={volk} q={q} cost={cost*1e4:.0f}bp | {summ2(n,bh,w)}")
    n,bh,_=None,None,None
