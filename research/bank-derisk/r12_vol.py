import os; os.environ["BD_DATA"]="data_max"; os.environ["BD_DSTART"]="2006-09-01"
from wf import *
from r3_kelly import fwd_var
from r4_ablate import summ
from r9_grid import stress_w
import pickle
OUT=pickle.load(open("r10_all.pkl","rb"))
# 1) ボラ予測の精度: ML(V) vs 素朴(vol20^2, vol5, EWMA) ; 評価=QLIKE と 相関(対数)
def qlike(f,r): return np.mean(r/f-np.log(r/f)-1)
print("== 5日先分散の予測精度 (OOS 2012-, 小さいほどQLIKE良) ==")
for a,(D,P,V,S) in OUT.items():
    fv=fwd_var(D).reindex(V.index); ok=fv.notna()&(fv>0)
    cands={"ML(ridge+lgb)":V,"vol20^2":(D.vol20**2).reindex(V.index),"vol5^2":(D.vol5**2).reindex(V.index),
           "vol60^2":(D.vol60**2).reindex(V.index),"EWMA(.94)":(D.vol20**2).ewm(alpha=0.06).mean().reindex(V.index)}
    line=[]
    for k,f in cands.items():
        m=ok&f.notna()&(f>0)
        # 比率補正: 全期間の平均比で水準合わせ(バイアス除去のため因果的でなく診断用)
        sc=(fv[m]/f[m]).mean(); line.append(f"{k}: QLIKE {qlike(f[m]*sc,fv[m]):.3f} corr {np.corrcoef(np.log(f[m]),np.log(fv[m]))[0,1]:.3f}")
    print(a," | ".join(line))
# 2) 方針比較: ボラ目標(ML予測 vs vol20) / ストレスヒステリシス / 組合せ
DS={a:pd.concat(build(a),axis=1) for a in OUT}
def policy(a,D,V,kind,tgt):
    idx=V.index; Dx=DS[a].reindex(idx)
    ann=lambda v:np.sqrt(v*245)
    if kind=="volML": w=(tgt/ann(V)).clip(upper=1)
    elif kind=="vol20": w=(tgt/(Dx.vol20*np.sqrt(245))).clip(upper=1)
    elif kind=="stress":
        Dd=Dx.dropna(subset=["vix_ma_ratio","volratio","dd60","kre_dd60"]); w=pd.Series(stress_w(Dd,1.25,1.8,-0.12,-0.12,2,3,0),index=Dd.index).reindex(idx)
    elif kind=="stress+volML":
        Dd=Dx.dropna(subset=["vix_ma_ratio","volratio","dd60","kre_dd60"]); s=pd.Series(stress_w(Dd,1.25,1.8,-0.12,-0.12,2,3,0),index=Dd.index).reindex(idx)
        w=s*(tgt/ann(V)).clip(upper=1)
    elif kind=="stress+vol20":
        Dd=Dx.dropna(subset=["vix_ma_ratio","volratio","dd60","kre_dd60"]); s=pd.Series(stress_w(Dd,1.25,1.8,-0.12,-0.12,2,3,0),index=Dd.index).reindex(idx)
        w=s*(tgt/(Dx.vol20*np.sqrt(245))).clip(upper=1)
    elif kind=="bh": w=pd.Series(1.0,index=idx)
    return w.fillna(1.0)
def bk(kind,tgt=0.3,cost=0.0005):
    ns,ys,ws=[],[],[]
    for a,(D,P,V,S) in OUT.items():
        w=policy(a,D,V,kind,tgt); y=D.y_oo.reindex(V.index); ok=y.notna()
        ns.append(net_ret(w[ok],y[ok],cost)); ys.append(y[ok]); ws.append(w[ok])
    return pd.concat(ns,axis=1).mean(axis=1),pd.concat(ys,axis=1).mean(axis=1),pd.concat(ws,axis=1).mean(axis=1)
print("\n== 方針比較 (OOS 2012-2026, 3メガバンク平均, cost5bp) ==")
for kind,tgt in [("bh",0),("vol20",0.30),("vol20",0.25),("volML",0.30),("volML",0.25),("stress",0),("stress+vol20",0.30),("stress+volML",0.30),("stress+volML",0.25)]:
    n,y,w=bk(kind,tgt)
    print(f"{kind:13s} tgt{tgt:<5}",summ(n,y,w))
    for nm,s,e in (("2012-17","2012-01-01","2017-12-31"),("2018-26","2018-01-01","2026-12-31")):
        m=(n.index>=s)&(n.index<=e); yrs=m.sum()/245; eq=n[m].cumsum(); dd=(np.exp(eq)/np.exp(eq).cummax()-1).min()
        print(f"      {nm}: CAGR {(np.exp(n[m].sum()/yrs)-1)*100:5.1f}% MDD {dd*100:6.1f}% Sh {n[m].mean()/n[m].std()*np.sqrt(245):.2f}")
