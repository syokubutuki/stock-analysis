from wf import *
import pickle
H=5
def label_df(D):
    z=np.log(D.open.shift(-H)/D.open) if "open" in D else None
    return z
def slow_wf(asset, start="2020-01-01", step=63, bad=-0.04):
    F,T=build(asset); a=load(asset)
    D=pd.concat([F,T],axis=1); D=D[D.index>="2017-06-01"]
    z5=np.log(a.open.shift(-H)/a.open).reindex(D.index)
    y=(z5<bad).astype(float); y[z5.isna()]=np.nan
    feats=list(F.columns); X=D[feats]; idx=D.index; oos=np.where(idx>=start)[0]
    out={m:pd.Series(np.nan,index=idx) for m in ("lgb","logit","ens")}
    sd_all=D.vol20.fillna(D.vol20.median())
    for b in range(0,len(oos),step):
        blk=oos[b:b+step]; t0=blk[0]; tr=np.arange(0,t0-(H+2)); tr=tr[y.iloc[tr].notna().values]
        Xtr=X.iloc[tr]; ytr=y.iloc[tr].astype(int)
        med=Xtr.median(); mu=Xtr.fillna(med).mean(); sd=Xtr.fillna(med).std().replace(0,1)
        A=((Xtr.fillna(med)-mu)/sd).clip(-5,5); B=((X.iloc[blk].fillna(med)-mu)/sd).clip(-5,5)
        lg=LogisticRegression(C=0.02,max_iter=500).fit(A,ytr); pl=lg.predict_proba(B)[:,1]
        gm=lgb.LGBMClassifier(n_estimators=150,learning_rate=0.03,num_leaves=5,min_child_samples=60,subsample=0.7,subsample_freq=1,colsample_bytree=0.6,reg_lambda=20,verbose=-1,n_jobs=4).fit(Xtr,ytr)
        pg=gm.predict_proba(X.iloc[blk])[:,1]
        out["logit"].iloc[blk]=pl; out["lgb"].iloc[blk]=pg; out["ens"].iloc[blk]=0.5*(pl+pg)
    P=pd.DataFrame(out).iloc[oos]
    return D,P,y
def weights_from_p(p, lo_q=0.5, hi_q=0.95, span=1, hist=750):
    v=p.values; w=np.ones(len(v))
    for i in range(len(v)):
        past=v[max(0,i-hist):i]
        if len(past)<60: continue
        lo,hi=np.quantile(past,[lo_q,hi_q])
        w[i]=1-np.clip((v[i]-lo)/(hi-lo+1e-12),0,1)
    w=pd.Series(w,index=p.index)
    return w.ewm(span=span,adjust=False).mean() if span>1 else w
if __name__=="__main__":
    from sklearn.metrics import roc_auc_score
    ALL={}
    for a in ["8306.T","8316.T","8411.T"]:
        D,P,y=slow_wf(a); ALL[a]=(D,P,y)
        yy=y.reindex(P.index); ok=yy.notna()
        print(a,"OOS base rate bad5:",round(yy[ok].mean(),3)," AUC:",{m:round(roc_auc_score(yy[ok],P[m][ok]),3) for m in P})
    pickle.dump(ALL,open("r8_all.pkl","wb"))
    print("\n--- 3メガバンク平均 OOS(2020-), cost 5bp ---")
    from r4_ablate import summ
    def bk(m,lo,hi,span,cost=0.0005):
        ns,ys,ws=[],[],[]
        for a,(D,P,y) in ALL.items():
            w=weights_from_p(P[m],lo,hi,span); yo=D.y_oo.reindex(P.index); ok=yo.notna()
            ns.append(net_ret(w[ok],yo[ok],cost)); ys.append(yo[ok]); ws.append(w[ok])
        return pd.concat(ns,axis=1).mean(axis=1),pd.concat(ys,axis=1).mean(axis=1),pd.concat(ws,axis=1).mean(axis=1)
    n,y,_=bk("ens",0.5,0.95,1); print("B&H     :",summ(y,y,pd.Series(1.0,index=y.index)))
    for m in ("lgb","logit","ens"):
        for lo,hi in ((0.5,0.95),(0.7,0.97),(0.3,0.9)):
            for span in (1,3):
                n,y,w=bk(m,lo,hi,span); tn=0
                print(f"{m:5s} lo{lo} hi{hi} span{span}:",summ(n,y,w))
