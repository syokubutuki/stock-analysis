import sys; sys.path.insert(0,'.')
from common import *
from scipy.stats import spearmanr
F,T=build("1615.T")
D=pd.concat([F,T],axis=1).dropna(subset=["y_oo"])
D=D[D.index>="2017-06-01"]
half=D.index[len(D)//2]
rows=[]
for f in F.columns:
    d=D[[f,"y_oo"]].dropna()
    if len(d)<500: continue
    ic=spearmanr(d[f],d.y_oo)[0]
    d2=D[[f]].assign(a=D.y_oo.abs()).dropna()
    icv=spearmanr(d2[f],d2.a)[0]
    a=d[d.index<half]; b=d[d.index>=half]
    rows.append((f,ic,spearmanr(a[f],a.y_oo)[0],spearmanr(b[f],b.y_oo)[0],icv))
R=pd.DataFrame(rows,columns=["feat","IC_all","IC_h1","IC_h2","IC_absret"]).set_index("feat")
n=len(D); se=1/np.sqrt(n)
print("n",n,"SE(IC)≈",round(se,3),"; 有意目安 |IC|>",round(2*se,3))
print("\n== 符号(翌日リターン)に対するIC 上位(|IC_all|) ==")
print(R.reindex(R.IC_all.abs().sort_values(ascending=False).index).head(12).round(3))
print("\n== 大きさ(|ret|)に対するIC 上位 ==")
print(R.reindex(R.IC_absret.abs().sort_values(ascending=False).index).head(8).round(3))
print("\n符号一致(前半/後半同符号) 割合:", ((np.sign(R.IC_h1)==np.sign(R.IC_h2))).mean().round(2))
