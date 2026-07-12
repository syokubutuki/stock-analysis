"use client";

// 週内10スロットの建玉プラン・グリッド(共有UI)。
// 1週間を10区間に分解: 各曜日の日中(始値→終値)5つ + オーバーナイト(終値→翌始値)5つ。
// 右端「金→月」が週末ギャップ。各区間に 買(long)/売(short)/現金(flat) を割り当てる。
// NisaVsTaxableChart / WeekdayPlanBuilder / WeekdayWorkbench が同じプラン表現を共有する。
import type { Side, BestCombination } from "../../lib/weekday-trade";

export type SlotSide = Side | "flat";

// 週内10スロットのラベル(0=月日中 .. 9=金オーバーナイト=週末)
export const SLOT_LABELS = ["月\n日中", "月→火\n夜間", "火\n日中", "火→水\n夜間", "水\n日中", "水→木\n夜間", "木\n日中", "木→金\n夜間", "金\n日中", "金→月\n週末"];

// 週末回避プリセット(月始〜金引けをロング、金→月の週末だけ現金)
export const AVOID_WEEKEND: SlotSide[] = ["long", "long", "long", "long", "long", "long", "long", "long", "long", "flat"];

// 全区間ロング(常時保有=バイ&ホールド相当)
export const ALL_LONG: SlotSide[] = new Array(10).fill("long");

export function cycleSide(s: SlotSide): SlotSide {
  return s === "flat" ? "long" : s === "long" ? "short" : "flat";
}
export function slotColor(s: SlotSide): string {
  return s === "long" ? "bg-emerald-600 text-white" : s === "short" ? "bg-rose-600 text-white" : "bg-white text-gray-400 border border-gray-200";
}
export function slotText(s: SlotSide): string {
  return s === "long" ? "買" : s === "short" ? "売" : "―";
}

export function bestSides(best: BestCombination | null | undefined): SlotSide[] {
  return best ? best.slots.map((s) => s.side) : [...AVOID_WEEKEND];
}

interface Props {
  sides: SlotSide[];
  onChange: (sides: SlotSide[]) => void;
  best?: BestCombination | null; // 「最適プラン」プリセット用
  title?: string;
  hint?: React.ReactNode;
}

export default function WeekSlotGrid({ sides, onChange, best, title = "週内どの区間を持つか", hint }: Props) {
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700">{title}</span>
        <div className="flex items-center gap-1 text-xs">
          <button onClick={() => onChange(bestSides(best))} className="px-2 py-0.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50">最適プラン</button>
          <button onClick={() => onChange([...AVOID_WEEKEND])} className="px-2 py-0.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50">週末回避(月→金)</button>
          <button onClick={() => onChange([...ALL_LONG])} className="px-2 py-0.5 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50">常時保有</button>
        </div>
      </div>
      <div className="grid grid-cols-10 gap-1">
        {SLOT_LABELS.map((label, i) => (
          <button
            key={i}
            onClick={() => onChange(sides.map((s, j) => (j === i ? cycleSide(s) : s)))}
            className={`flex flex-col items-center rounded py-1 text-[10px] leading-tight transition-colors ${slotColor(sides[i] ?? "flat")}`}
            title="クリックで 無→買→売 を切替"
          >
            <span className="whitespace-pre text-center opacity-80">{label}</span>
            <span className="text-sm font-bold mt-0.5">{slotText(sides[i] ?? "flat")}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-1.5">
        {hint ?? (
          <>各区間をクリックで 無（現金）→ 買 → 売 を切替。緑=買・赤=売・灰=現金。右端「金→月」が週末ギャップ。</>
        )}
      </p>
    </div>
  );
}
