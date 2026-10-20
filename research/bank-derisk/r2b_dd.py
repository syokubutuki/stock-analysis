from wf import *
import pickle
RES=pickle.load(open("r2_preds.pkl","rb"))
D,P=RES["8306.T"]; y=D.y_oo.reindex(P.index).dropna(); P=P.loc[y.index]
eq=y.cumsum(); dd=(np.exp(eq)/np.exp(eq).cummax()-1)
# 主要DD局面: B&H で -15% を超えたエピソードを抽出
ep=[]; peak=None; inep=False
pk=eq.cummax()
for t in dd.index:
    pass
under=dd< -0.12
starts=(under & ~under.shift(1,fill_value=False))
print("B&H -12%超DDエピソード(8306.T): 谷の日付と深さ")
g=(~under).cumsum()
for k,grp in dd[under].groupby(g[under]):
    print("  ",grp.index[0].date(),"〜",grp.index[-1].date(),"最深",round(grp.min()*100,1),"%  日数",len(grp))
# 手法別に各エピソード中の戦略寄与を比較
def w_of(m,q): return to_weights_by_quantile(P[m],q)
for m,q in [("lgb_reg",0.35),("ens_all",0.35),("ridge",0.2)]:
    w=w_of(m,q); n=net_ret(w,y)
    print(f"\n{m} q{q}: エピソード別 B&H累積 vs 戦略累積 / 平均建玉")
    for k,grp in dd[under].groupby(g[under]):
        s,e=grp.index[0],grp.index[-1]
        print(f"   {s.date()}〜{e.date()} B&H {np.exp(y[s:e].sum())-1:+.1%}  strat {np.exp(n[s:e].sum())-1:+.1%}  inMkt {w[s:e].mean():.0%}")
