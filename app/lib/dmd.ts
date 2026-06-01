/**
 * Dynamic Mode Decomposition (DMD)
 * 価格時系列から支配的な振動モードを抽出
 */

export interface DMDMode {
  /** 周期（日数）。Inf = トレンド成分 */
  period: number;
  /** 成長/減衰率（1.0 = 安定、>1 = 成長、<1 = 減衰） */
  growthRate: number;
  /** 寄与度（%） */
  contribution: number;
  /** モード再構成時系列 */
  reconstruction: number[];
}

export interface DMDResult {
  /** 抽出されたモード（寄与度降順） */
  modes: DMDMode[];
  /** 元系列 */
  original: number[];
  /** 全モードの重ね合わせによる再構成 */
  totalReconstruction: number[];
}

/**
 * 簡易SVDベースのDMD実装
 * Hankel行列を構築し、SVDで低ランク近似 → 固有値分解
 */
export function computeDMD(
  values: number[],
  maxModes: number = 5,
  embedDim: number = 0
): DMDResult {
  const empty: DMDResult = { modes: [], original: values, totalReconstruction: [] };
  const n = values.length;
  if (n < 30) return empty;

  // 埋め込み次元（自動設定）
  const m = embedDim > 0 ? embedDim : Math.min(Math.floor(n / 3), 50);
  const k = n - m; // 列数

  if (k < m || m < 3) return empty;

  // Hankel行列 X (m × k-1) と X' (m × k-1)
  // X[:, j] = values[j:j+m], X'[:, j] = values[j+1:j+1+m]
  const X: number[][] = [];
  const Xp: number[][] = [];
  for (let i = 0; i < m; i++) {
    X.push([]);
    Xp.push([]);
    for (let j = 0; j < k - 1; j++) {
      X[i].push(values[j + i]);
      Xp[i].push(values[j + 1 + i]);
    }
  }

  // 簡易SVD: Power iteration で上位r個の特異ベクトルを近似
  const r = Math.min(maxModes * 2, m, k - 1);

  // X の共分散行列 X*X^T の上位固有ベクトル
  const cols = k - 1;

  // X*X^T を計算 (m×m)
  const C: number[][] = [];
  for (let i = 0; i < m; i++) {
    C.push(new Array(m).fill(0));
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let l = 0; l < cols; l++) s += X[i][l] * X[j][l];
      C[i][j] = s;
      if (i !== j) C[j][i] = s;
    }
  }

  // Power iteration with deflation for top-r eigenvectors
  const eigvecs: number[][] = [];
  const eigvals: number[] = [];
  const Cwork = C.map((row) => [...row]);

  for (let mode = 0; mode < r; mode++) {
    let v = new Array(m).fill(0).map(() => Math.random() - 0.5);
    let norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    v = v.map((x) => x / norm);

    for (let iter = 0; iter < 100; iter++) {
      const w = new Array(m).fill(0);
      for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) w[i] += Cwork[i][j] * v[j];
      }
      norm = Math.sqrt(w.reduce((a, b) => a + b * b, 0));
      if (norm < 1e-12) break;
      v = w.map((x) => x / norm);
    }

    const ev = v.reduce((s, vi, i) => {
      let sum = 0;
      for (let j = 0; j < m; j++) sum += Cwork[i][j] * v[j];
      return s + vi * sum;
    }, 0);

    eigvals.push(ev);
    eigvecs.push(v);

    // Deflation
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        Cwork[i][j] -= ev * v[i] * v[j];
      }
    }
  }

  // 特異値 & 左特異ベクトル
  const sigmas = eigvals.map((e) => Math.sqrt(Math.max(0, e)));
  const U = eigvecs; // m × r

  // 右特異ベクトル V = X^T * U * Sigma^{-1}
  const V: number[][] = [];
  for (let j = 0; j < cols; j++) {
    const row: number[] = [];
    for (let mode = 0; mode < r; mode++) {
      if (sigmas[mode] < 1e-10) {
        row.push(0);
        continue;
      }
      let s = 0;
      for (let i = 0; i < m; i++) s += X[i][j] * U[mode][i];
      row.push(s / sigmas[mode]);
    }
    V.push(row);
  }

  // Atilde = U^T * X' * V * Sigma^{-1}  (r × r)
  // まず X' * V を計算
  const XpV: number[][] = [];
  for (let i = 0; i < m; i++) {
    XpV.push([]);
    for (let mode = 0; mode < r; mode++) {
      let s = 0;
      for (let j = 0; j < cols; j++) s += Xp[i][j] * V[j][mode];
      XpV[i].push(s);
    }
  }

  // U^T * XpV
  const Atilde: number[][] = [];
  for (let i = 0; i < r; i++) {
    Atilde.push([]);
    for (let j = 0; j < r; j++) {
      let s = 0;
      for (let l = 0; l < m; l++) s += U[i][l] * XpV[l][j];
      const inv = sigmas[j] > 1e-10 ? 1 / sigmas[j] : 0;
      Atilde[i].push(s * inv);
    }
  }

  // Atilde の固有値を2×2ブロックで近似推定（簡易版）
  // 対角要素と2×2ブロックから固有値を抽出
  const dmdModes: DMDMode[] = [];
  const dt = 1; // 1日

  const processed = new Set<number>();
  for (let i = 0; i < r && dmdModes.length < maxModes; i++) {
    if (processed.has(i)) continue;
    processed.add(i);

    const a = Atilde[i][i];

    // 隣のオフ対角成分をチェック（複素固有値ペア）
    if (i + 1 < r && Math.abs(Atilde[i][i + 1]) > 1e-10) {
      processed.add(i + 1);
      const b = Atilde[i][i + 1];
      const c = Atilde[i + 1][i];
      const d = Atilde[i + 1][i + 1];

      // 2×2行列の固有値: λ = (a+d)/2 ± sqrt(((a-d)/2)^2 + b*c)
      const tr = (a + d) / 2;
      const disc = ((a - d) / 2) ** 2 + b * c;

      let growthRate: number;
      let period: number;

      if (disc < 0) {
        // 複素固有値ペア
        const realPart = tr;
        const imagPart = Math.sqrt(-disc);
        growthRate = Math.sqrt(realPart ** 2 + imagPart ** 2);
        const freq = Math.atan2(imagPart, realPart) / (2 * Math.PI * dt);
        period = freq > 1e-8 ? 1 / freq : Infinity;
      } else {
        growthRate = Math.abs(tr + Math.sqrt(disc));
        period = Infinity;
      }

      if (period < 0) period = -period;

      // モード再構成（簡易: U[:, i] * sigma[i] の寄与）
      const contrib = (sigmas[i] ** 2 + (i + 1 < r ? sigmas[i + 1] ** 2 : 0));
      const totalEnergy = sigmas.reduce((a, b) => a + b * b, 0);
      const contribution = totalEnergy > 0 ? (contrib / totalEnergy) * 100 : 0;

      // 再構成: cos波で近似
      const recon = new Array(n).fill(0);
      if (period < Infinity && period > 1) {
        const omega = (2 * Math.PI) / period;
        const amp = sigmas[i] / Math.sqrt(cols);
        for (let t = 0; t < n; t++) {
          recon[t] = amp * Math.cos(omega * t) * (growthRate ** t);
        }
        // スケール合わせ
        const maxRecon = Math.max(...recon.map(Math.abs));
        const maxOrig = Math.max(...values.map(Math.abs));
        if (maxRecon > 0) {
          const scale = (maxOrig * contribution / 100) / maxRecon;
          for (let t = 0; t < n; t++) recon[t] *= scale;
        }
      }

      dmdModes.push({ period, growthRate, contribution, reconstruction: recon });
    } else {
      // 実固有値
      const growthRate = Math.abs(a);
      const contribution = sigmas[i] ** 2 / sigmas.reduce((a, b) => a + b * b, 0) * 100;

      const recon = new Array(n).fill(0);
      // トレンド成分
      const amp = sigmas[i] / Math.sqrt(cols);
      for (let t = 0; t < n; t++) {
        recon[t] = amp * (a ** t);
      }
      const maxRecon = Math.max(...recon.map(Math.abs));
      const maxOrig = Math.max(...values.map(Math.abs));
      if (maxRecon > 0) {
        const scale = (maxOrig * contribution / 100) / maxRecon;
        for (let t = 0; t < n; t++) recon[t] *= scale;
      }

      dmdModes.push({ period: Infinity, growthRate, contribution, reconstruction: recon });
    }
  }

  // 寄与度で降順ソート
  dmdModes.sort((a, b) => b.contribution - a.contribution);

  // 全モード再構成
  const totalReconstruction = new Array(n).fill(0);
  for (const mode of dmdModes) {
    for (let t = 0; t < n; t++) {
      totalReconstruction[t] += mode.reconstruction[t];
    }
  }

  return { modes: dmdModes, original: values, totalReconstruction };
}
