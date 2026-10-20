"""ウォークフォワード共通部。学習は常に「予測日より前に確定した行」だけ。"""
import sys; sys.path.insert(0,'.')
import numpy as np, pandas as pd, warnings, os
from common import *
from sklearn.linear_model import Ridge, LogisticRegression
import lightgbm as lgb
warnings.filterwarnings("ignore")

def dataset(asset="1615.T", target="y_oo"):
    F,T=build(asset)
    D=pd.concat([F,T],axis=1)
    D=D[D.index>=os.environ.get("BD_DSTART","2017-06-01")]
    return D, list(F.columns)

def sig(D, k=4):
    """外れ値クリップ用の因果的σ(vol20は既に t-1 まで)。"""
    return D.vol20.fillna(D.vol20.median())

def make_models(seed=0):
    return {
      "ridge":  lambda: ("reg", Ridge(alpha=300.0)),
      "logit":  lambda: ("clf", LogisticRegression(C=0.02, max_iter=500)),
      "lgb_reg":lambda: ("reg", lgb.LGBMRegressor(n_estimators=150, learning_rate=0.03, num_leaves=5, min_child_samples=60,
                    subsample=0.7, subsample_freq=1, colsample_bytree=0.6, reg_lambda=20, random_state=seed, verbose=-1, n_jobs=4)),
      "lgb_clf":lambda: ("clf", lgb.LGBMClassifier(n_estimators=150, learning_rate=0.03, num_leaves=5, min_child_samples=60,
                    subsample=0.7, subsample_freq=1, colsample_bytree=0.6, reg_lambda=20, random_state=seed, verbose=-1, n_jobs=4)),
    }

def walk_forward(D, feats, target="y_oo", start="2020-01-01", step=63, embargo=3, models=None, label="cls"):
    """各モデルの OOS 予測(連続スコア)を返す。reg=予測リターン、clf=P(上昇)"""
    models = models or make_models()
    X = D[feats]; y = D[target]
    idx = D.index; oos = np.where(idx >= start)[0]
    preds = {m: pd.Series(np.nan, index=idx) for m in models}
    for b in range(0, len(oos), step):
        blk = oos[b:b+step]; t0 = blk[0]
        tr = np.arange(0, t0 - embargo)
        tr = tr[y.iloc[tr].notna().values]
        Xtr = X.iloc[tr]; ytr = y.iloc[tr]
        s = sig(D).iloc[tr]
        ytr_c = np.clip(ytr, -4*s, 4*s)           # 外れ値抑制
        med = Xtr.median(); mu = (Xtr.fillna(med)).mean(); sd = (Xtr.fillna(med)).std().replace(0,1)
        for name, mk in models.items():
            kind, m = mk()
            if name in ("ridge","logit"):
                A = ((Xtr.fillna(med) - mu)/sd).clip(-5,5); B = ((X.iloc[blk].fillna(med) - mu)/sd).clip(-5,5)
            else:
                A = Xtr; B = X.iloc[blk]
            if kind == "reg":
                m.fit(A, ytr_c); p = m.predict(B)
            else:
                m.fit(A, (ytr > 0).astype(int)); p = m.predict_proba(B)[:,1]
            preds[name].iloc[blk] = p
    return pd.DataFrame(preds).iloc[oos]

def to_weights_by_quantile(score, q, hist_min=250, expanding=True):
    """スコアの過去分布(因果的)の下位 q を現金に。連続スコア→0/1。"""
    w = pd.Series(1.0, index=score.index)
    vals = score.values
    for i in range(len(vals)):
        past = vals[max(0,i-750):i] if i>=hist_min//5 else vals[:i]
        if len(past) < 30 or np.isnan(vals[i]): w.iloc[i]=1.0; continue
        w.iloc[i] = 0.0 if vals[i] <= np.quantile(past, q) else 1.0
    return w

def alpha_vs_bh(strat_net, bh, ann=245, lags=5):
    """strat = a + b*bh + e の a(年率) と NW t値"""
    import numpy.linalg as la
    d = pd.concat([strat_net, bh], axis=1).dropna(); y_ = d.iloc[:,0].values; x_ = d.iloc[:,1].values
    X = np.column_stack([np.ones(len(x_)), x_]); beta = la.lstsq(X, y_, rcond=None)[0]
    e = y_ - X@beta; n=len(y_)
    S = (X*e[:,None]); V = S.T@S/n
    for L in range(1, lags+1):
        G = S[L:].T@S[:-L]/n; V += (1-L/(lags+1))*(G+G.T)
    XtXi = la.inv(X.T@X/n); cov = XtXi@V@XtXi/n
    return beta[0]*ann, beta[0]/np.sqrt(cov[0,0]), beta[1]

def net_ret(w, y, cost=0.0005):
    dw = w.diff().abs().fillna(w.abs())
    return w*y - cost*dw
