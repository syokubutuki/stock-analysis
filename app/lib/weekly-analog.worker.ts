// 今週の軌跡アナログの重い計算をメインスレッドから逃がす Web Worker(改善 C3/A3)。
//  - kind "cross":   ウォッチリスト全銘柄へ computeWeeklyAnalog を一斉適用(横断表)
//  - kind "oos":     単一設定のウォークフォワード OOS 検証
//  - kind "catalog": 設定カタログ総当たりの OOS スキャン(多重比較補正)

import { PricePoint } from "./types";
import { UsReturn, BinScheme } from "./us-spillover-core";
import {
  computeWeeklyAnalog, WeeklyAnalogResult, WeeklyAnalogParams,
} from "./weekly-analog";
import {
  runWeeklyAnalogOos, runWeeklyAnalogOosCatalog, OosResult, OosCatalog, OosSetting,
} from "./weekly-analog-oos";

type CrossParams = Omit<WeeklyAnalogParams, "prices" | "us" | "poolSeries">;

export interface CrossRequest {
  reqId: number;
  kind: "cross";
  tickers: string[];
  pricesByTicker: Record<string, PricePoint[]>;
  us: UsReturn[];
  params: CrossParams;
  pool: boolean; // B5 横断プール(他銘柄を候補に含める)
}

export interface OosRequest {
  reqId: number;
  kind: "oos";
  prices: PricePoint[];
  us: UsReturn[];
  setting: OosSetting;
  scheme: BinScheme;
  H: number;
  maxWeeks: number;
}

export interface CatalogRequest {
  reqId: number;
  kind: "catalog";
  prices: PricePoint[];
  us: UsReturn[];
  scheme: BinScheme;
  H: number;
  K: number;
  maxWeeks: number;
}

export type AnalogWorkerRequest = CrossRequest | OosRequest | CatalogRequest;

export interface CrossRow { ticker: string; res: WeeklyAnalogResult | null; }
export interface AnalogWorkerResponse {
  reqId: number;
  kind: "cross" | "oos" | "catalog";
  rows?: CrossRow[];
  oos?: OosResult | null;
  catalog?: OosCatalog | null;
  error?: string;
}

self.onmessage = (ev: MessageEvent<AnalogWorkerRequest>) => {
  const req = ev.data;
  const post = (r: AnalogWorkerResponse) => (self as unknown as Worker).postMessage(r);
  try {
    if (req.kind === "cross") {
      const { tickers, pricesByTicker, us, params, pool } = req;
      const rows: CrossRow[] = tickers.map((ticker) => {
        const prices = pricesByTicker[ticker];
        if (!prices || prices.length < 120) return { ticker, res: null };
        const poolSeries = pool
          ? tickers.filter((t) => t !== ticker && pricesByTicker[t]?.length >= 120)
              .map((t) => ({ ticker: t, prices: pricesByTicker[t] }))
          : undefined;
        const res = computeWeeklyAnalog({ prices, us, poolSeries, skipNovelty: true, ...params });
        return { ticker, res };
      });
      post({ reqId: req.reqId, kind: "cross", rows });
    } else if (req.kind === "oos") {
      const oos = runWeeklyAnalogOos({
        prices: req.prices, us: req.us, usTicker: "", setting: req.setting,
        scheme: req.scheme, H: req.H, maxWeeks: req.maxWeeks,
      });
      post({ reqId: req.reqId, kind: "oos", oos });
    } else {
      const catalog = runWeeklyAnalogOosCatalog({
        prices: req.prices, us: req.us, usTicker: "", scheme: req.scheme,
        H: req.H, K: req.K, maxWeeks: req.maxWeeks,
      });
      post({ reqId: req.reqId, kind: "catalog", catalog });
    }
  } catch (err) {
    post({ reqId: req.reqId, kind: req.kind, error: String(err) });
    console.error("weekly-analog worker error", err);
  }
};
