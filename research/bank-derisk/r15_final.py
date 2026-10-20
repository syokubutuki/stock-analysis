import os, sys
from wf import *
from r13_variants import stv, hyst
CFG=dict(k_in=2,calm_n=5,k_out=0)
def run(assets,start):
    out={}
    for a in assets:
        D=pd.concat(build(a),axis=1); D=D[D.index>=start]
        Dv=D.dropna(subset=["vix_ma_ratio","volratio","dd60","kre_dd60"])
        st=pd.Series(stv(Dv),index=Dv.index); w=pd.Series(hyst(st.values,**CFG),index=Dv.index)
        out[a]=(D.reindex(Dv.index),st,w)
    return out
mode=sys.argv[1]
if mode=="full":
    R=run(["8306.T","8316.T","8411.T"],"2006-09-01")
    ys=pd.concat([R[a][0].y_oo for a in R],axis=1).dropna(); 
    print("コスト感度(全期間 2006-09~, 3メガバンク平均):")
    for c in (0,0.0005,0.001,0.002):
        n=pd.concat([net_ret(R[a][2],R[a][0].y_oo,c) for a in R],axis=1).mean(axis=1).dropna(); y=ys.mean(axis=1).reindex(n.index)
        yrs=len(n)/245; mdd=(np.exp(n.cumsum())/np.exp(n.cumsum()).cummax()-1).min()
        print(f"  片道{c*1e4:3.0f}bp: CAGR {(np.exp(n.sum()/yrs)-1)*100:5.1f}% MDD {mdd*100:6.1f}% Sh {n.mean()/n.std()*np.sqrt(245):.2f}  (B&H CAGR {(np.exp(y.sum()/yrs)-1)*100:.1f}% MDD {(np.exp(y.cumsum())/np.exp(y.cumsum()).cummax()-1).min()*100:.1f}%)")
    nn=pd.concat([net_ret(R[a][2],R[a][0].y_oo,0.0005) for a in R],axis=1).mean(axis=1)
    yb=pd.concat([R[a][0].y_oo for a in R],axis=1).mean(axis=1); wb=pd.concat([R[a][2] for a in R],axis=1).mean(axis=1)
    WIN=[("リーマン危機","2007-07-01","2009-03-31"),("東日本大震災","2011-03-01","2011-06-30"),("中国・マイナス金利","2015-06-01","2016-07-31"),
         ("2018年","2018-01-15","2018-12-31"),("コロナ","2020-02-15","2020-04-30"),("2024年8月","2024-07-04","2024-09-30"),
         ("2025年4月","2025-03-20","2025-05-15"),("2026年3月","2026-02-20","2026-04-30")]
    print("\n主要局面(3メガバンク平均): 期間累積と窓内最大DD  B&H vs ルール / 現金日割合")
    for nm,s_,e_ in WIN:
        m=(yb.index>=s_)&(yb.index<=e_)
        f=lambda x:(np.exp(x[m].sum())-1, (np.exp(x[m].cumsum())/np.exp(x[m].cumsum()).cummax()-1).min())
        b=f(yb); r=f(nn)
        print(f"  {nm:10s} {s_}~{e_}  B&H {b[0]*100:+6.1f}% (DD {b[1]*100:6.1f}%)  ルール {r[0]*100:+6.1f}% (DD {r[1]*100:6.1f}%)  現金 {(1-wb[m]).mean()*100:3.0f}%")
else:
    R=run(["8306.T","8316.T","8411.T"],"2017-06-01")
    print("直近の状態 (判断日=各銘柄データ最終日の翌営業日の朝7時時点の入力)")
    for a,(D,st,w) in R.items():
        d=D.iloc[-1]; 
        print(f"{a}: 最終行 {D.index[-1].date()}  stress={int(st.iloc[-1])}/4  建玉={'保有' if w.iloc[-1]>0.5 else '現金'}   vix_ma比={d.vix_ma_ratio:.2f}(>1.25で点灯) volratio={d.volratio:.2f}(>1.8) dd60={d.dd60*100:.1f}%(<-12) kre_dd60={d.kre_dd60*100:.1f}%(<-12)")
    D,st,w=R["8306.T"]
    x=pd.DataFrame({"stress":st,"w":w,"vixMA":D.vix_ma_ratio.round(2),"vr":D.volratio.round(2),"dd60%":(D.dd60*100).round(1),"kre%":(D.kre_dd60*100).round(1)})
    print(x["2026-02-20":].to_string())
