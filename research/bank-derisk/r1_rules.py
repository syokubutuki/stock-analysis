import sys; sys.path.insert(0,'.')
from common import *
F,T=build("1615.T")
D=pd.concat([F,T],axis=1).dropna(subset=["y_oo","sma200","dd252","vol60","vix","nq_ret1","kre_ret1"])
y=D.y_oo
def rep(name,w,mask=None):
    m = np.ones(len(D),bool) if mask is None else mask
    return name, perf(pd.Series(w,index=D.index)[m], y[m])
masks={"ALL 2018-":np.ones(len(D),bool),"2020-":(D.index>="2020-01-01")}
rules={}
rules["B&H"]=np.ones(len(D))
for x in (0,):
    rules["sma200>0"]=(D.sma200>0).astype(float)
rules["sma50>0"]=(D.sma50>0).astype(float)
for th in (-0.05,-0.08,-0.10,-0.15): rules[f"dd60>{th}"]=(D.dd60>th).astype(float)
for th in (-0.10,-0.15,-0.20): rules[f"dd120>{th}"]=(D.dd120>th).astype(float)
for k in (0.15,0.2,0.25,0.3):  # 年率ボラ目標
    s=(D.vol20*np.sqrt(245)); rules[f"voltgt{int(k*100)}"]=(k/s).clip(upper=1)
for th in (20,25,30): rules[f"vix<{th}"]=(D.vix<th).astype(float)
rules["vix_ma<1.2"]=(D.vix_ma_ratio<1.2).astype(float)
for th in (0.005,0.01,0.015): rules[f"nq<{th}"]=(D.nq_ret1<th).astype(float)
rules["nq<0.01 half"]=np.where(D.nq_ret1<0.01,1.0,0.5)
rules["dd60>-.08 & vix<25"]=((D.dd60>-0.08)&(D.vix<25)).astype(float)
rules["sma200 & nq<.01"]=((D.sma200>0)&(D.nq_ret1<0.01)).astype(float)
rules["voltgt20 & nq<.01"]=(0.2/(D.vol20*np.sqrt(245))).clip(upper=1)*(D.nq_ret1<0.01)
rules["voltgt25 x nqhalf"]=(0.25/(D.vol20*np.sqrt(245))).clip(upper=1)*np.where(D.nq_ret1<0.01,1.0,0.5)
rules["kre_dd60>-.1 & dd60>-.08"]=((D.kre_dd60>-0.10)&(D.dd60>-0.08)).astype(float)
for lab,m in masks.items():
    print("=====",lab, "n=",m.sum())
    for k,w in rules.items():
        n,p=rep(k,np.asarray(w,float),m)
        print(f"{n:26s} {fmt(p)}")
    # 同一在市比率の定数B&H(参考)
