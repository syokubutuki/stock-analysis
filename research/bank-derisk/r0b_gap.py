import sys; sys.path.insert(0,'.')
from common import *
from scipy.stats import spearmanr
for asset in ["1615.T","8306.T","8316.T","8411.T"]:
    F,T=build(asset)
    D=pd.concat([F,T],axis=1).dropna(subset=["y_oo","nq_ret1","sp_ret1"])
    D=D[D.index>="2017-06-01"]
    out=[]
    for tgt in ["y_oo","y_id","y_on"]:
        out.append(f"{tgt}: IC(nq)={spearmanr(D.nq_ret1,D[tgt])[0]:+.3f} IC(sp)={spearmanr(D.sp_ret1,D[tgt])[0]:+.3f}")
    # 当日ギャップ自体(事後)との関係: 米国→gap の順方向影響と gap→日中 の戻り
    a=load(asset); gap=np.log(a.open/a.close.shift(1)).reindex(D.index)
    out.append(f"corr(US→gap)={spearmanr(D.sp_ret1,gap,nan_policy='omit')[0]:+.3f}  corr(gap→id)={spearmanr(gap,D.y_id,nan_policy='omit')[0]:+.3f}")
    print(asset,"|"," | ".join(out))
# 時代別(1615)
F,T=build("1615.T"); D=pd.concat([F,T],axis=1).dropna(subset=["y_id","nq_ret1"])
for y in range(2017,2027):
    d=D[D.index.year==y]
    if len(d)>50: print(y, len(d), f"IC(nq→id)={spearmanr(d.nq_ret1,d.y_id)[0]:+.3f}", f"IC(nq→oo)={spearmanr(d.nq_ret1,d.y_oo)[0]:+.3f}", f"IC(nq→on)={spearmanr(d.nq_ret1,d.y_on)[0]:+.3f}")
