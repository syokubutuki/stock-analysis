from wf import *
import os
assets=["8306.T","8316.T","8411.T"]
DS={a:pd.concat(build(a),axis=1) for a in assets}
def mkrules(D):
    R={}
    R["B&H"]=pd.Series(1.0,index=D.index)
    for th in (1.15,1.25,1.4): R[f"vixMA<{th}"]=(D.vix_ma_ratio<th).astype(float)
    for th in (25,30,35): R[f"vix<{th}"]=(D.vix<th).astype(float)
    for th in (1.5,2.0): R[f"volratio<{th}"]=(D.volratio<th).astype(float)
    for th in (0.45,0.6,0.8): R[f"vol20ann<{th}"]=(D.vol20*np.sqrt(245)<th).astype(float)
    R["kre_dd60>-.15"]=(D.kre_dd60>-0.15).astype(float)
    R["sp_dd60>-.08"]=(D.sp_dd60>-0.08).astype(float)
    R["topix_dd60>-.10"]=(D.topix_dd60>-0.10).astype(float)
    stress=((D.vix_ma_ratio>1.25).astype(int)+(D.volratio>1.8).astype(int)+(D.dd60<-0.12).astype(int)+(D.kre_dd60<-0.12).astype(int))
    for k in (2,3): R[f"stress<{k}of4"]=(stress<k).astype(float)
    # ヒステリシス: stress>=2で退出 → stress==0 が3日続いたら復帰
    st=stress.values; w=np.ones(len(st)); cur=1; calm=0
    for i in range(len(st)):
        if cur==1 and st[i]>=2: cur=0; calm=0
        elif cur==0:
            calm = calm+1 if st[i]==0 else 0
            if calm>=3: cur=1
        w[i]=cur
    R["stress-hyst"]=pd.Series(w,index=D.index)
    return R
START=os.environ.get("BD_START","2018-01-01"); END=os.environ.get("BD_END","2100-01-01")
rows={}
for a,D in DS.items():
    D=D[(D.index>=START)&(D.index<=END)].dropna(subset=["y_oo","vix_ma_ratio","volratio","dd60"])
    for k,w in mkrules(D).items():
        w=w.loc[D.index]; n=net_ret(w,D.y_oo,0.0005)
        rows.setdefault(k,[]).append((n,D.y_oo,w))
print(f"期間 {START}- n={len(D)}  3メガバンク平均, cost5bp/片道")
print(f"{'rule':16s} {'CAGR':>6s} {'vol':>5s} {'Sh':>5s} {'MDD':>7s} {'inMkt':>5s} {'turn':>5s} | 現金日の年率平均/年率ボラ | α(t)")
for k,L in rows.items():
    n=pd.concat([x[0] for x in L],axis=1).mean(axis=1); y=pd.concat([x[1] for x in L],axis=1).mean(axis=1); w=pd.concat([x[2] for x in L],axis=1).mean(axis=1)
    yrs=len(n)/245; dd=(np.exp(n.cumsum())/np.exp(n.cumsum()).cummax()-1).min()
    turn=np.mean([x[2].diff().abs().sum() for x in L])/yrs
    cash=(w<0.5); cm=y[cash].mean()*245*100 if cash.sum()>20 else np.nan; cv=y[cash].std()*np.sqrt(245)*100 if cash.sum()>20 else np.nan
    al,t,b=alpha_vs_bh(n,y)
    print(f"{k:16s} {(np.exp(n.sum()/yrs)-1)*100:5.1f}% {n.std()*np.sqrt(245)*100:4.1f}% {n.mean()/n.std()*np.sqrt(245):5.2f} {dd*100:6.1f}% {w.mean()*100:4.0f}% {turn:5.1f} | {cm:+7.1f}% /{cv:5.1f}% (cash日{cash.sum()}) | {al*100:+5.1f}%({t:+.1f})")
