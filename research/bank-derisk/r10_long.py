import os; os.environ["BD_DATA"]="data_max"; os.environ["BD_DSTART"]="2006-09-01"
from wf import *
from r3_kelly import vol_wf, kelly_w
from r8_slowml import weights_from_p
from sklearn.metrics import roc_auc_score
import pickle, sys
OOS="2012-01-01"; H=5
def zexp(s):
    m=s.expanding(60).mean().shift(1); sd=s.expanding(60).std().shift(1); return (s-m)/sd
OUT={}
for a in ["8306.T","8316.T","8411.T"]:
    D,feats=dataset(a)
    P=walk_forward(D,feats,"y_oo",start=OOS)
    Z=P.apply(zexp); P["ens_all"]=Z[["ridge","logit","lgb_reg","lgb_clf"]].mean(axis=1)
    V=vol_wf(D,feats,start=OOS)
    # slow crash classifier
    z5=np.log(load(a).open.shift(-H)/load(a).open).reindex(D.index); yb=(z5<-0.04).astype(float); yb[z5.isna()]=np.nan
    X=D[feats]; idx=D.index; oos=np.where(idx>=OOS)[0]
    pl=pd.Series(np.nan,index=idx); pg=pd.Series(np.nan,index=idx)
    for b in range(0,len(oos),63):
        blk=oos[b:b+63]; t0=blk[0]; tr=np.arange(0,t0-(H+2)); tr=tr[yb.iloc[tr].notna().values]
        Xtr=X.iloc[tr]; ytr=yb.iloc[tr].astype(int); med=Xtr.median(); mu=Xtr.fillna(med).mean(); sd=Xtr.fillna(med).std().replace(0,1)
        A=((Xtr.fillna(med)-mu)/sd).clip(-5,5); B=((X.iloc[blk].fillna(med)-mu)/sd).clip(-5,5)
        pl.iloc[blk]=LogisticRegression(C=0.02,max_iter=500).fit(A,ytr).predict_proba(B)[:,1]
        pg.iloc[blk]=lgb.LGBMClassifier(n_estimators=150,learning_rate=0.03,num_leaves=5,min_child_samples=60,subsample=0.7,subsample_freq=1,colsample_bytree=0.6,reg_lambda=20,verbose=-1,n_jobs=4).fit(Xtr,ytr).predict_proba(X.iloc[blk])[:,1]
    S=pd.DataFrame({"logit":pl,"lgb":pg,"ens":0.5*(pl+pg)}).iloc[oos]
    yy=yb.reindex(S.index); ok=yy.notna()
    print(a,"slow crash AUC (OOS 2012-):",{m:round(roc_auc_score(yy[ok],S[m][ok]),3) for m in S}, "base rate",round(yy[ok].mean(),3)); sys.stdout.flush()
    OUT[a]=(D,P,V,S)
pickle.dump(OUT,open("r10_all.pkl","wb"))
print("done")
