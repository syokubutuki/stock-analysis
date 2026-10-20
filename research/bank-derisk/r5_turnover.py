from wf import *
from r4_ablate import basket, summ
import pickle
ALL=pickle.load(open("r4_all.pkl","rb"))
def post(w, mode, p):
    w=w.copy()
    if mode=="raw": return w
    if mode=="levels":   # p 段階に丸め
        return (np.round(w*p)/p)
    if mode=="deadband":
        out=w.copy(); cur=w.iloc[0]
        for i,(t,v) in enumerate(w.items()):
            if abs(v-cur)>=p: cur=v
            out.iloc[i]=cur
        return out
    if mode=="ema":
        return w.ewm(span=p,adjust=False).mean()
    if mode=="ema+lvl":
        return (np.round(w.ewm(span=p,adjust=False).mean()*4)/4)
def run(mode,p,cost):
    R={}
    for a,res in ALL.items():
        w,yy=res["ALL"]; R[a]={"x":(post(w,mode,p),yy)}
    return basket(R,"x",cost)
print("後処理(回転抑制)   | cost5bp                                                            | cost10bp α(t)    cost20bp α(t)")
for mode,p in [("raw",0),("levels",2),("levels",4),("deadband",0.15),("deadband",0.3),("deadband",0.5),("ema",3),("ema",5),("ema",10),("ema+lvl",3)]:
    n,y,w=run(mode,p,0.0005); 
    line=f"{mode:9s}{p:<5}| {summ(n,y,w)}"
    # turnover
    tn=sum((post(res['ALL'][0],mode,p).diff().abs().sum()) for res in ALL.values())/len(ALL)/(len(n)/245)
    n1,y1,_=run(mode,p,0.001); n2,y2,_=run(mode,p,0.002)
    a1=alpha_vs_bh(n1,y1); a2=alpha_vs_bh(n2,y2)
    print(f"{line} turn {tn:5.0f}x | {a1[0]*100:+5.1f}%({a1[1]:+.1f})  {a2[0]*100:+5.1f}%({a2[1]:+.1f})")
