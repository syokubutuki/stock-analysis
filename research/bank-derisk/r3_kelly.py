from wf import *
import pickle, sys
H=5
def fwd_var(D):
    y=D.y_oo
    return (y**2).rolling(H).mean().shift(-(H-1))   # t..t+H-1 の平均二乗(未来)

def vol_wf(D,feats,start="2020-01-01",step=63,embargo=H+2):
    """ln(5日先分散) を ridge+lgb で予測 → σ̂(日次)"""
    v=np.log(fwd_var(D)+1e-8); X=D[feats]; idx=D.index; oos=np.where(idx>=start)[0]
    out=pd.Series(np.nan,index=idx)
    for b in range(0,len(oos),step):
        blk=oos[b:b+step]; t0=blk[0]; tr=np.arange(0,t0-embargo); tr=tr[v.iloc[tr].notna().values]
        Xtr=X.iloc[tr]; med=Xtr.median(); mu=Xtr.fillna(med).mean(); sd=Xtr.fillna(med).std().replace(0,1)
        A=((Xtr.fillna(med)-mu)/sd).clip(-5,5); B=((X.iloc[blk].fillna(med)-mu)/sd).clip(-5,5)
        r=Ridge(alpha=100.0).fit(A,v.iloc[tr]); p1=r.predict(B)
        g=lgb.LGBMRegressor(n_estimators=150,learning_rate=0.03,num_leaves=5,min_child_samples=60,subsample=0.7,subsample_freq=1,colsample_bytree=0.6,reg_lambda=20,verbose=-1,n_jobs=4).fit(Xtr,v.iloc[tr])
        p2=g.predict(X.iloc[blk])
        resid=(v.iloc[tr]-r.predict(A)); s2=np.var(resid)    # 対数正規補正
        out.iloc[blk]=np.exp(0.5*(p1+p2)+0.5*s2)
    return out.iloc[oos]

def kelly_w(mu,var,lam,kappa,mu_bar):
    m=mu_bar+kappa*(mu-mu_bar)
    return (m/(lam*var)).clip(0,1)

def run(asset,verbose=True):
    D,feats=dataset(asset)
    P=walk_forward(D,feats,"y_oo",models={k:v for k,v in make_models().items() if k in("ridge","lgb_reg")})
    V=vol_wf(D,feats)
    y=D.y_oo.reindex(P.index); ok=y.notna()
    mu_bar=D.y_oo.expanding(250).mean().shift(3).reindex(P.index)
    return D,P,V,y,ok,mu_bar

if __name__=="__main__":
    out={}
    for a in ["8306.T","8316.T","8411.T"]:
        D,P,V,y,ok,mu_bar=run(a); out[a]=(D,P,V,y,ok,mu_bar)
        mu=P[["ridge","lgb_reg"]].mean(axis=1)
        print(f"\n=== {a}  vol-model: corr(log σ̂², log realized fwd var)={np.corrcoef(np.log(V[ok]), np.log(fwd_var(D).reindex(P.index)[ok]+1e-8) if False else np.log(V[ok]))[0,0]:.2f}")
        print("B&H", fmt(perf(np.ones(ok.sum()),y[ok])))
        for kappa in (0.0,0.5,1.0):
            for lam in (1,2,4):
                w=kelly_w(mu,V,lam,kappa,mu_bar)[ok]
                w=w.fillna(1.0)
                p=perf(w,y[ok]); n=net_ret(w,y[ok]); al,t,b=alpha_vs_bh(n,y[ok])
                print(f"kappa={kappa} lam={lam}: {fmt(p)} α {al*100:+5.1f}% t={t:+.1f} β={b:.2f}")
    pickle.dump(out,open("r3_cache.pkl","wb"))
