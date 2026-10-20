import os; os.environ["BD_DATA"]="data_max"
from wf import *
from r9_grid import DS, stats
def stv(D,vixr=1.25,volr=1.8,dd=-0.12,kre=-0.12):
    return ((D.vix_ma_ratio>vixr).astype(int)+(D.volratio>volr).astype(int)+(D.dd60<dd).astype(int)+(D.kre_dd60<kre).astype(int)).values
def hyst(st,k_in=2,calm_n=3,k_out=0):
    w=np.ones(len(st)); cur=1; calm=0
    for i in range(len(st)):
        if cur==1:
            if st[i]>=k_in: cur=0; calm=0
        else:
            calm=calm+1 if st[i]<=k_out else 0
            if calm>=calm_n: cur=1
        w[i]=cur
    return w
def graded(st,step=0.34,floor=0.0,calm_n=3):
    """st=0→1, 悪化するほど段階縮小。復帰は calm_n 日 st が現水準以下を連続(ラチェット)"""
    w=np.ones(len(st)); cur=1.0; calm=0
    for i in range(len(st)):
        tgt=max(floor,1-step*st[i])
        if tgt<cur: cur=tgt; calm=0
        elif tgt>cur:
            calm+=1
            if calm>=calm_n: cur=min(tgt,cur+step); calm=0
        else: calm=0
        w[i]=cur
    return w
V={
 "B&H":lambda D:np.ones(len(D)),
 "hyst(2,3,0) base":lambda D:hyst(stv(D),2,3,0),
 "hyst(2,5,0)":lambda D:hyst(stv(D),2,5,0),
 "hyst(2,8,0)":lambda D:hyst(stv(D),2,8,0),
 "hyst(2,12,0)":lambda D:hyst(stv(D),2,12,0),
 "hyst(3,3,0)":lambda D:hyst(stv(D),3,3,0),
 "graded step.34 calm3":lambda D:graded(stv(D),0.34,0,3),
 "graded step.5 calm3":lambda D:graded(stv(D),0.5,0,3),
 "graded step.5 calm5":lambda D:graded(stv(D),0.5,0,5),
 "graded step.25 calm3":lambda D:graded(stv(D),0.25,0,3),
 "graded step.5 floor.25":lambda D:graded(stv(D),0.5,0.25,3),
}
if __name__=="__main__":
    eras=(("06-09","2006-09-01","2009-12-31"),("10-12","2010-01-01","2012-12-31"),("13-17","2013-01-01","2017-12-31"),("18-26","2018-01-01","2026-12-31"))
    if __name__=="__main__": print("variant table in r13 main")
    for k,f in V.items():
        ns=[];ys=[];ws=[]
        for a,D in DS.items():
            w=pd.Series(f(D),index=D.index); ns.append(net_ret(w,D.y_oo,0.0005)); ys.append(D.y_oo); ws.append(w)
        n=pd.concat(ns,axis=1).mean(axis=1); y=pd.concat(ys,axis=1).mean(axis=1); w=pd.concat(ws,axis=1).mean(axis=1)
        s=stats(n,y,w); line=f"{k:24s} {s['cagr']*100:8.1f}% {s['mdd']*100:6.1f}% {s['sh']:5.2f} {s['inm']*100:4.0f}% {s['turn']:5.1f} |"
        for nm,a_,b_ in eras:
            m=(n.index>=a_)&(n.index<=b_); yrs=m.sum()/245; eq=n[m].cumsum(); dd=(np.exp(eq)/np.exp(eq).cummax()-1).min()
            line+=f" {nm}: {(np.exp(n[m].sum()/yrs)-1)*100:5.1f}%/{dd*100:5.1f}%"
        print(line)
