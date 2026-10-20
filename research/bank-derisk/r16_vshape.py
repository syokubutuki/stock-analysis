import os; os.environ["BD_DATA"]="data_max"
from wf import *
from r9_grid import stats
assets=["8306.T","8316.T","8411.T"]
kre=load("KRE").close
def feat(a):
    D=pd.concat(build(a),axis=1); c=load(a).close.reindex(D.index)
    D["dd20"]=(c/c.rolling(20).max()-1).shift(1)
    kd=(kre/kre.rolling(20).max()-1); D["kre_dd20"]=asof_us(kd,D.index)
    D["ret3"]=D.ret3
    return D[D.index>="2006-09-01"].dropna(subset=["y_oo","vix_ma_ratio","volratio","dd60","kre_dd60","dd20","kre_dd20"])
DS={a:feat(a) for a in assets}
def state(D,mode):
    vx=(D.vix_ma_ratio>1.25).astype(int); vr=(D.volratio>1.8).astype(int)
    if mode=="base":   a=(D.dd60<-0.12).astype(int); b=(D.kre_dd60<-0.12).astype(int)
    elif mode=="dd20": a=(D.dd20<-0.10).astype(int); b=(D.kre_dd20<-0.10).astype(int)
    elif mode=="dd20b":a=(D.dd20<-0.08).astype(int); b=(D.kre_dd20<-0.08).astype(int)
    return (vx+vr+a+b).values, (vx+vr).values
def hyst2(st,fast,k_in,calm_n,use_fast_exit):
    out=np.ones(len(st)); cur=1; calm=0
    for i in range(len(st)):
        if cur==1:
            if st[i]>=k_in: cur=0; calm=0
        else:
            ok=(fast[i]==0) if use_fast_exit else (st[i]==0)
            calm=calm+1 if ok else 0
            if calm>=calm_n: cur=1
        out[i]=cur
    return out
V={"base(dd60,5)":("base",2,5,False),"base(dd60,3)":("base",2,3,False),
   "dd20 -10%, calm5":("dd20",2,5,False),"dd20 -10%, calm3":("dd20",2,3,False),"dd20 -8%, calm5":("dd20b",2,5,False),
   "dd60, 速い指標だけで復帰5":("base",2,5,True),"dd20, 速い指標だけで復帰3":("dd20",2,3,True),"dd20, 速い指標だけで復帰5":("dd20",2,5,True)}
WIN=[("リーマン","2007-07-01","2009-03-31"),("震災","2011-03-01","2011-06-30"),("中国/マイナス金利","2015-06-01","2016-07-31"),("2018","2018-01-15","2018-12-31"),
     ("コロナ","2020-02-15","2020-04-30"),("2024-08","2024-07-04","2024-09-30"),("2025-04","2025-03-20","2025-05-15"),("2026-03","2026-02-20","2026-04-30")]
eras=(("06-09","2006-09-01","2009-12-31"),("10-12","2010-01-01","2012-12-31"),("13-17","2013-01-01","2017-12-31"),("18-26","2018-01-01","2026-12-31"))
def cum(x,m): return np.exp(x[m].sum())-1
print(f"{'variant':26s}{'CAGR':>6s}{'MDD':>7s}{'Sh':>5s}{'inM':>5s}{'turn':>5s} | 時代別CAGR/MDD | 局面累積: "+" ".join(w[0] for w in WIN))
yb=pd.concat([D.y_oo for D in DS.values()],axis=1).mean(axis=1)
for k,(mode,kin,cn,fe) in V.items():
    ns=[];ws=[]
    for a,D in DS.items():
        st,fast=state(D,mode); w=pd.Series(hyst2(st,fast,kin,cn,fe),index=D.index); ns.append(net_ret(w,D.y_oo,0.0005)); ws.append(w)
    n=pd.concat(ns,axis=1).mean(axis=1); w=pd.concat(ws,axis=1).mean(axis=1); s=stats(n,yb,w)
    line=f"{k:26s}{s['cagr']*100:5.1f}%{s['mdd']*100:6.1f}%{s['sh']:5.2f}{s['inm']*100:4.0f}%{s['turn']:5.1f} |"
    for nm,a_,b_ in eras:
        m=(n.index>=a_)&(n.index<=b_); yrs=m.sum()/245; eq=n[m].cumsum(); dd=(np.exp(eq)/np.exp(eq).cummax()-1).min()
        line+=f" {(np.exp(n[m].sum()/yrs)-1)*100:4.0f}/{dd*100:4.0f}"
    line+=" |"
    for nm,a_,b_ in WIN:
        m=(n.index>=a_)&(n.index<=b_); line+=f" {cum(n,m)*100:+4.0f}"
    print(line)
m=lambda a_,b_:(yb.index>=a_)&(yb.index<=b_)
print("B&H 局面累積:"," ".join(f"{cum(yb,m(a_,b_))*100:+4.0f}" for _,a_,b_ in WIN))
