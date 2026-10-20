import os; os.environ["BD_DATA"]="data_max"
from wf import *
from r13_variants import stv, hyst
from r9_grid import stats
rng=np.random.default_rng(0)
CFG=dict(k_in=2,calm_n=5,k_out=0)
def load_asset(a,start="2006-09-01"):
    D=pd.concat(build(a),axis=1); return D[(D.index>=start)].dropna(subset=["y_oo","vix_ma_ratio","volratio","dd60","kre_dd60"])
def policy_w(D): return pd.Series(hyst(stv(D),**CFG),index=D.index)
def metrics(n,y):
    yrs=len(n)/245; mdd=(np.exp(n.cumsum())/np.exp(n.cumsum()).cummax()-1).min()
    return dict(cagr=np.exp(n.sum()/yrs)-1, mdd=mdd, sh=n.mean()/n.std()*np.sqrt(245))
# ---------- (1) 配置ヌル: 同じ現金期間の長さ・本数をランダムな位置に置く ----------
def episodes(w):
    v=(w.values<0.5).astype(int); e=[]; i=0
    while i<len(v):
        if v[i]: j=i
        else: i+=1; continue
        while j<len(v) and v[j]: j+=1
        e.append(j-i); i=j
    return e
def random_w(n,ep):
    w=np.ones(n); lens=list(rng.permutation(ep))
    # 重ならないよう逐次配置(失敗時は再試行)
    for _ in range(50):
        w=np.ones(n); ok=True
        for L in lens:
            for _t in range(30):
                s=rng.integers(0,n-L)
                if w[max(0,s-1):s+L+1].min()==1: w[s:s+L]=0; break
            else: ok=False; break
        if ok: return w
    return w
print("== (1) ランダム配置ヌル (3メガバンク, 全期間2006-09~) ==")
assets=["8306.T","8316.T","8411.T"]; DSx={a:load_asset(a) for a in assets}
ns=[];ys=[];ep_info={}
for a,D in DSx.items():
    w=policy_w(D); ns.append(net_ret(w,D.y_oo,0.0005)); ys.append(D.y_oo); ep_info[a]=episodes(w)
act=metrics(pd.concat(ns,axis=1).mean(axis=1),pd.concat(ys,axis=1).mean(axis=1)); print("実際:",{k:round(v,3) for k,v in act.items()}, "episodes",{a:len(e) for a,e in ep_info.items()})
sims=[]
for s in range(1000):
    nn=[]
    for a,D in DSx.items():
        w=pd.Series(random_w(len(D),ep_info[a]),index=D.index); nn.append(net_ret(w,D.y_oo,0.0005))
    sims.append(metrics(pd.concat(nn,axis=1).mean(axis=1),None))
S=pd.DataFrame(sims)
print(S.describe(percentiles=[.05,.5,.95]).round(3).loc[["5%","50%","95%"]])
for k,better in (("mdd",lambda x:x>=act["mdd"]),("cagr",lambda x:x>=act["cagr"]),("sh",lambda x:x>=act["sh"])):
    print(f"  P(ランダム >= 実際 | {k}) = {better(S[k]).mean():.3f}")
# ---------- (2) 別銘柄 ----------
print("\n== (2) 設計に使っていない銘柄 (同一固定ルール, cost5bp) ==")
print(f"{'asset':8s} {'B&H CAGR/MDD/Sh':>26s} | {'rule CAGR/MDD/Sh':>26s} | inMkt  turn")
for a in ["8308.T","8309.T","8331.T","8354.T","7203.T","6758.T","1321.T"]:
    try:
        D=load_asset(a, "2009-06-01" if a=="1321.T" else "2006-09-01")
        w=policy_w(D); n=net_ret(w,D.y_oo,0.0005); y=D.y_oo
        b=metrics(y,y); r=metrics(n,y); yrs=len(D)/245
        print(f"{a:8s} {b['cagr']*100:6.1f}%/{b['mdd']*100:6.1f}%/{b['sh']:5.2f} | {r['cagr']*100:6.1f}%/{r['mdd']*100:6.1f}%/{r['sh']:5.2f} | {w.mean()*100:4.0f}% {w.diff().abs().sum()/yrs:5.1f}")
    except Exception as e: print(a,"ERR",e)
# ---------- (3) ブロックブートストラップ ----------
print("\n== (3) 定常ブロックブートストラップ(平均ブロック長20日, 2000回) 3メガバンクバスケット ==")
n=pd.concat(ns,axis=1).mean(axis=1); y=pd.concat(ys,axis=1).mean(axis=1)
def sb(N,L=20):
    idx=np.empty(N,int); i=0
    while i<N:
        s=rng.integers(0,N); l=rng.geometric(1/L)
        l=min(l,N-i); idx[i:i+l]=(s+np.arange(l))%N; i+=l
    return idx
d_cagr=[];d_mdd=[];d_sh=[]
for _ in range(2000):
    ix=sb(len(n)); nb=pd.Series(n.values[ix]); yb=pd.Series(y.values[ix]); a=metrics(nb,None); b=metrics(yb,None)
    d_cagr.append(a["cagr"]-b["cagr"]); d_mdd.append(a["mdd"]-b["mdd"]); d_sh.append(a["sh"]-b["sh"])
for nm,d in (("CAGR差",d_cagr),("MDD差(正=浅い)",d_mdd),("Sharpe差",d_sh)):
    d=np.array(d); print(f"  {nm}: 中央値 {np.median(d):+.3f}  90%CI [{np.percentile(d,5):+.3f}, {np.percentile(d,95):+.3f}]  P(>0)={np.mean(d>0):.2f}")
