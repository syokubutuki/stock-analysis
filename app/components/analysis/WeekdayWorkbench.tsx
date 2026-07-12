"use client";

// 曜日トレード・ワークベンチ。
// 「①エッジ発見 → ②プラン構築 → ③評価(対B&H・対NISA/レバ)」を1か所に集約し、
// 週内スロット・プラン(sides)を全ステージで共有する。②で作ったプランがそのまま③で
// 検定・税引後評価される。これまで螺旋ヒートマップ内・別アコーディオンに散っていた
// 曜日トレードの発見〜評価の動線を一本化する。
//
// プランは銘柄非依存で localStorage 永続化(再検索しても編集したプランを維持)。
// 一度も編集していなければ、その銘柄の bestCombination(最適プラン)に追従する。

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { PricePoint } from "../../lib/types";
import { bestCombination, type PlanGapFill } from "../../lib/weekday-trade";
import { type SlotSide, bestSides } from "./WeekSlotGrid";
import WeekdayPlanBuilder from "./WeekdayPlanBuilder";

const WeekdayEdgeScanChart = dynamic(() => import("./WeekdayEdgeScanChart"), { ssr: false });
const WeekdayVsBuyHoldChart = dynamic(() => import("./WeekdayVsBuyHoldChart"), { ssr: false });
const NisaVsTaxableChart = dynamic(() => import("./NisaVsTaxableChart"), { ssr: false });
const WeekdayTradeSimulator = dynamic(() => import("./WeekdayTradeSimulator"), { ssr: false });

interface Props {
  prices: PricePoint[];
}

const PLAN_KEY = "wt-workbench-plan-v1";
const CFG_KEY = "wt-workbench-cfg-v1";

function loadPlan(): SlotSide[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PLAN_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length === 10) return arr as SlotSide[];
  } catch { /* noop */ }
  return null;
}
function loadCfg(): { gapFill: PlanGapFill; costBps: number } {
  if (typeof window === "undefined") return { gapFill: "cash", costBps: 5 };
  try {
    const raw = window.localStorage.getItem(CFG_KEY);
    if (raw) { const o = JSON.parse(raw); return { gapFill: o.gapFill === "hold" ? "hold" : "cash", costBps: Number(o.costBps) || 0 }; }
  } catch { /* noop */ }
  return { gapFill: "cash", costBps: 5 };
}

// ステージ折りたたみ(重い①③を畳めるように)
function Stage({ n, title, children, defaultOpen = true, accent }: { n: string; title: string; children: React.ReactNode; defaultOpen?: boolean; accent: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-gray-200">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white ${accent}`}>{n}</span>
        <span className="text-sm font-medium text-gray-700">{title}</span>
        <span className="ml-auto text-gray-400 text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="border-t border-gray-100 p-3">{children}</div>}
    </div>
  );
}

export default function WeekdayWorkbench({ prices }: Props) {
  const best = useMemo(() => (prices.length > 60 ? bestCombination(prices, true) : null), [prices]);
  const [sides, setSides] = useState<SlotSide[] | null>(() => loadPlan());
  const cfg0 = useMemo(() => loadCfg(), []);
  const [gapFill, setGapFill] = useState<PlanGapFill>(cfg0.gapFill);
  const [costBps, setCostBps] = useState(cfg0.costBps);

  // 未編集なら銘柄の最適プランに追従、編集済みなら固定
  const effSides: SlotSide[] = sides ?? bestSides(best);

  const editPlan = (next: SlotSide[]) => {
    setSides(next);
    try { window.localStorage.setItem(PLAN_KEY, JSON.stringify(next)); } catch { /* noop */ }
  };
  useEffect(() => {
    try { window.localStorage.setItem(CFG_KEY, JSON.stringify({ gapFill, costBps })); } catch { /* noop */ }
  }, [gapFill, costBps]);

  if (prices.length < 60) {
    return <div className="text-sm text-gray-500 p-4">データが不足しています（60営業日以上が必要）。</div>;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        曜日トレードの<span className="font-medium">発見 → プラン化 → 評価</span>を1か所に集約したワークベンチです。
        ②で組んだ週内プランが、そのまま③の<span className="font-medium">対バイ&ホールド検定</span>と
        <span className="font-medium">NISA vs 現物 税引後・レバレッジ比較</span>に流れます。プランは編集すると保存され、
        別銘柄に切り替えても維持されます（未編集ならその銘柄の最適プランに追従）。
      </p>

      <Stage n="①" title="エッジ発見：曜日タイミング好機スキャン（統計的にどこが良いか）" accent="bg-amber-500" defaultOpen={false}>
        <p className="text-xs text-gray-500 mb-2">
          どの曜日×タイミングに統計的なエッジがあるかを俯瞰します。ここで見えた優位区間を、②の<span className="font-medium">最適プラン</span>ボタン
          （過去データで富を最大化する買/売/現金の組合せ）で建玉プランに落とし込めます。
        </p>
        <WeekdayEdgeScanChart prices={prices} />
      </Stage>

      <Stage n="②" title="プラン構築：週内スロットを組んで累積リターンを見る" accent="bg-blue-600">
        <WeekdayPlanBuilder
          prices={prices}
          sides={effSides}
          onChange={editPlan}
          gapFill={gapFill}
          onGapFill={setGapFill}
          costBps={costBps}
          onCostBps={setCostBps}
        />
      </Stage>

      <Stage n="②" title="詳細シミュレータ：フィット窓 / 逐次WF検証 / 全組合せヒートマップ / ランキング" accent="bg-blue-600" defaultOpen={false}>
        <p className="text-xs text-gray-500 mb-2">
          螺旋ヒートマップから移設した高機能シミュレータ。フィット窓やウォークフォワードでの過剰適合チェック、任意の曜日×注文タイミング×方向の編集、
          注文タイミング全4通りのヒートマップができます。<span className="font-medium">「② 共有プランへ送る」</span>で、その最適プラン（週内10スロット）を上の共有プランに反映し、③の税引後・レバ評価に使えます。
        </p>
        <WeekdayTradeSimulator prices={prices} onSendPlan={editPlan} />
      </Stage>

      <Stage n="③" title="評価A：NISA(非課税) vs 現物(課税・このプラン) 税引後・レバレッジ比較" accent="bg-emerald-600">
        <NisaVsTaxableChart prices={prices} plan={effSides} />
      </Stage>

      <Stage n="③" title="評価B：月→金戦略 vs バイ&ホールド 統計的優位性検定" accent="bg-emerald-600" defaultOpen={false}>
        <p className="text-xs text-gray-500 mb-2">
          週末をまたがない「月→金」プランのB&Hに対する優位性を、差の対数分解で非重複部分（主に週末ギャップ）だけ4検定します。
        </p>
        <WeekdayVsBuyHoldChart prices={prices} />
      </Stage>
    </div>
  );
}
