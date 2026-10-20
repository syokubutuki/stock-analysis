import os; os.environ["BD_DATA"]="data_max"
from wf import *
import itertools
assets=["8306.T","8316.T","8411.T"]
DS={}
for a in assets:
    D=pd.concat(build(a),axis=1); D=D[(D.index>="2006-09-01")].dropna(subset=["y_oo","vix_ma_ratio","volratio","dd60","kre_dd60"]); DS[a]=D
idx=DS["8306.T"].index
def stress_w(D, vixr, volr, dd, kre, k_in, calm_n, k_out):
    st=((D.vix_ma_ratio>vixr).astype(int)+(D.volratio>volr).astype(int)+(D.dd60<dd).astype(int)+(D.kre_dd60<kre).astype(int)).values
    w=np.ones(len(st)); cur=1; calm=0
    for i in range(len(st)):
        if cur==1:
            if st[i]>=k_in: cur=0; calm=0
        else:
            calm = calm+1 if st[i]<=k_out else 0
            if calm>=calm_n: cur=1
        w[i]=cur
    return w
def evalcfg(p, cost=0.0005):
    ns=[];ys=[];ws=[]
    for a,D in DS.items():
        w=pd.Series(stress_w(D,*p),index=D.index); ns.append(net_ret(w,D.y_oo,cost)); ys.append(D.y_oo); ws.append(w)
    n=pd.concat(ns,axis=1).mean(axis=1); y=pd.concat(ys,axis=1).mean(axis=1); w=pd.concat(ws,axis=1).mean(axis=1)
    return n,y,w
def stats(n,y,w):
    yrs=len(n)/245; eq=n.cumsum(); mdd=(np.exp(eq)/np.exp(eq).cummax()-1).min()
    tn=w.diff().abs().sum()/yrs
    return dict(cagr=np.exp(n.sum()/yrs)-1, vol=n.std()*np.sqrt(245), sh=n.mean()/n.std()*np.sqrt(245), mdd=mdd, inm=w.mean(), turn=tn)
if __name__=="__main__":
    grid=list(itertools.product((1.15,1.25,1.4),(1.5,1.8,2.2),(-0.10,-0.12,-0.15),(-0.10,-0.12,-0.15),(2,3),(1,3,5),(0,1)))
    n,y,w=evalcfg((9,9,-9,-9,9,1,0))  # 常に保有(B&H)
    bh=stats(y,y,pd.Series(1.0,index=y.index)); print("B&H 2006-09..2026-10:", {k:round(v,3) for k,v in bh.items()})
    rows=[]
    for p in grid:
        n,y,w=evalcfg(p); s=stats(n,y,w); al,t,b=alpha_vs_bh(n,y); s.update(alpha=al,t=t,cfg=p); rows.append(s)
    R=pd.DataFrame(rows)
    R["calmar"]=R.cagr/-R.mdd
    print(f"\n{len(R)} 設定の分布 (全期間):")
    print(R[["cagr","vol","sh","mdd","calmar","inm","turn","alpha","t"]].describe(percentiles=[.1,.5,.9]).round(3).loc[["min","10%","50%","90%","max"]])
    print(f"\n最大DDが B&H({bh['mdd']:.1%}) より浅い設定の割合: {(R.mdd>bh['mdd']).mean():.0%};  -40%より浅い割合: {(R.mdd>-0.40).mean():.0%}")
    print(f"CAGRが B&H({bh['cagr']:.1%}) 以上の割合: {(R.cagr>=bh['cagr']).mean():.0%};  Sharpeが B&H({bh['sh']:.2f}) 以上: {(R.sh>=bh['sh']).mean():.0%}")
    print(f"α>0 の割合: {(R.alpha>0).mean():.0%};  t>2: {(R.t>2).mean():.0%}")
    print("\n--- 1パラメータずつの周辺平均(他は全組合せ平均) ---")
    names=["vixMA","volratio","dd60","kre_dd60","k_in","calm_n","k_out"]
    for i,nm in enumerate(names):
        R[nm]=[c[i] for c in R.cfg]
        print(R.groupby(nm)[["cagr","sh","mdd","calmar","inm","turn","alpha"]].mean().round(3).to_string(),"\n")
    R.drop(columns=["cfg"]).to_csv("r9_grid.csv",index=False)
