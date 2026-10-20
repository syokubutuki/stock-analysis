from wf import *
from r3_kelly import vol_wf, kelly_w, H
import itertools, pickle, sys
GROUPS={}
def groups(feats):
    jp=[f for f in feats if not f.startswith(("topix","n225","rel20","sp_","nq_","sox_","kre","xlf","fx_","tnx","vix","dow","month","exdiv"))]
    mk=[f for f in feats if f.startswith(("topix","n225","rel20"))]
    us=[f for f in feats if f.startswith(("sp_","nq_","sox_","kre","xlf","fx_","tnx","vix"))]
    cal=[f for f in feats if f in("dow","month","exdiv")]
    return dict(jp=jp,mk=mk,us=us,cal=cal)

def mean_scores(D,feats,use):
    P=walk_forward(D,use,"y_oo",models={k:v for k,v in make_models().items() if k in("ridge","lgb_reg")})
    return P[["ridge","lgb_reg"]].mean(axis=1)

def evaluate(asset, cfgs, cost=0.0005, lam=2, kappa=1.0, cache={}):
    D,feats=dataset(asset); G=groups(feats)
    key=(asset,"V")
    if key not in cache: cache[key]=vol_wf(D,feats)
    V=cache[key]
    y=D.y_oo; out={}
    mu_bar=D.y_oo.expanding(250).mean().shift(3)
    for name,use in cfgs.items():
        k=(asset,name)
        if k not in cache: cache[k]=mean_scores(D,feats,use) if use else None
        mu=cache[k]
        if mu is None: w=(mu_bar.reindex(V.index)/(lam*V)).clip(0,1)   # 純ボラ目標のみ
        else: w=kelly_w(mu,V,lam,kappa,mu_bar.reindex(mu.index))
        w=w.reindex(V.index).fillna(1.0); yy=y.reindex(V.index); ok=yy.notna()
        out[name]=(w[ok],yy[ok])
    return out

def basket(res_by_asset,name,cost):
    nets=[]; ws=[]; ys=[]
    for a,res in res_by_asset.items():
        w,yy=res[name]; nets.append(net_ret(w,yy,cost)); ys.append(yy); ws.append(w)
    n=pd.concat(nets,axis=1).mean(axis=1); y=pd.concat(ys,axis=1).mean(axis=1); w=pd.concat(ws,axis=1).mean(axis=1)
    return n,y,w

def summ(n,y,w,ann=245):
    yrs=len(n)/ann; eq=n.cumsum(); dd=(np.exp(eq)/np.exp(eq).cummax()-1).min()
    al,t,b=alpha_vs_bh(n,y)
    return f"CAGR {(np.exp(n.sum()/yrs)-1)*100:5.1f}% vol {n.std()*np.sqrt(ann)*100:4.1f}% Sh {n.mean()/n.std()*np.sqrt(ann):4.2f} MDD {dd*100:5.1f}% inMkt {w.mean()*100:3.0f}% α {al*100:+5.1f}% (t={t:+.1f}) β={b:.2f}"

if __name__=="__main__":
    assets=["8306.T","8316.T","8411.T"]
    ALL={}
    for a in assets:
        D,feats=dataset(a); G=groups(feats)
        cfgs={"ALL":feats,"noUS":G["jp"]+G["mk"]+G["cal"],"USonly":G["us"],"noCal":G["jp"]+G["mk"]+G["us"],
              "JPown":G["jp"],"VIX+JPvol":[f for f in feats if f.startswith("vix") or f.startswith(("vol","parkinson","downvol"))],
              "US-1d only":["sp_ret1","nq_ret1","sox_ret1","kre_ret1","xlf_ret1","fx_ret1","tnx_ret1"],"VOLONLY":None}
        ALL[a]=evaluate(a,cfgs)
    print("== アブレーション (3メガバンクのバスケット, kappa=1 lam=2, cost 5bp) 2020-2026 ==")
    n0,y0,_=basket(ALL,"ALL",0.0005)
    print(f"{'B&H':14s} CAGR {(np.exp(y0.sum()/(len(y0)/245))-1)*100:5.1f}% vol {y0.std()*np.sqrt(245)*100:4.1f}% Sh {y0.mean()/y0.std()*np.sqrt(245):4.2f} MDD {((np.exp(y0.cumsum())/np.exp(y0.cumsum()).cummax()-1).min())*100:5.1f}%")
    for name in ALL["8306.T"]:
        n,y,w=basket(ALL,name,0.0005); print(f"{name:14s}",summ(n,y,w))
    print("\n== コスト感度 (ALL) ==")
    for c in (0,0.0005,0.001,0.002,0.003):
        n,y,w=basket(ALL,"ALL",c); print(f"cost {c*1e4:4.0f}bp:",summ(n,y,w))
    print("\n== 暦年別 (ALL, 5bp) vs B&H ==")
    n,y,w=basket(ALL,"ALL",0.0005)
    for yr in range(2020,2027):
        m=n.index.year==yr
        print(yr, f"strat {np.exp(n[m].sum())-1:+6.1%}  B&H {np.exp(y[m].sum())-1:+6.1%}  inMkt {w[m].mean():.0%}  MDD strat {((np.exp(n[m].cumsum())/np.exp(n[m].cumsum()).cummax()-1).min()):.1%} B&H {((np.exp(y[m].cumsum())/np.exp(y[m].cumsum()).cummax()-1).min()):.1%}")
    pickle.dump(ALL,open("r4_all.pkl","wb"))
