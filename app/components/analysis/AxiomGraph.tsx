"use client";

// 株式原論の系譜図 ─ 公準/公理 → 命題 → 系 の依存グラフ(インタラクティブ)。
//
// 静的な3段グリッドでは「どの系がどの公準に立脚するか」が文字列でしか分からなかった。
// ここでは実際のエッジを引き、ノードにホバー/クリックすると導出経路だけが浮かび上がる:
//   - 系にホバー  → その系が辿る公準・命題を根まで遡って強調(祖先)
//   - 公準にホバー → その公準に立脚する命題・系を強調(子孫)
// クリックで固定(ピン留め)、系クリックで該当カードへスクロール。
//
// SVG を使う(Canvas2D ではなく): ノード単位のホバー/クリック・スクロール連携が
// DOM イベントで自然に書け、テキストも選択・拡大できるため。

import { useMemo, useState } from "react";
import {
  COROLLARIES,
  PROPOSITION_BASIS,
  AXIOM_LABEL,
  type AxiomRef,
} from "../../lib/axioms/corollaries";

const POSTULATES: AxiomRef[] = ["公準1", "公準2", "公準3", "公準4", "公準5"];
const AXIOMS: AxiomRef[] = ["公理1", "公理2", "公理3", "公理4", "公理5"];
const PROPOSITIONS: AxiomRef[] = ["命題1", "命題2", "命題3", "命題4", "命題5"];

// 描画領域。横幅は固定し、狭い画面では親側で横スクロールさせる。
const W = 980;
const Y_ROOT = 34; // 公準・公理の段
const Y_PROP = 132; // 命題の段
const Y_COR = 236; // 系の段
const H = 290;

type NodeKind = "postulate" | "axiom" | "proposition" | "corollary";

interface GNode {
  id: string; // "公準4" / "命題2" / "C1"
  label: string; // ノードに描く短いテキスト
  title: string; // ホバー時に出す完全な説明
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
}

const KIND_STYLE: Record<NodeKind, { fill: string; stroke: string; text: string }> = {
  postulate: { fill: "#eef2ff", stroke: "#6366f1", text: "#3730a3" },
  axiom: { fill: "#f8fafc", stroke: "#94a3b8", text: "#334155" },
  proposition: { fill: "#eff6ff", stroke: "#3b82f6", text: "#1e40af" },
  corollary: { fill: "#ecfdf5", stroke: "#10b981", text: "#065f46" },
};

/** 段ごとに等間隔で x 座標を割り当てる。 */
function spread(count: number, i: number): number {
  return ((i + 0.5) * W) / count;
}

function buildGraph() {
  const nodes: GNode[] = [];

  // 上段: 公準(左半分) + 公理(右半分)。合計10ノード。
  const roots = [...POSTULATES, ...AXIOMS];
  roots.forEach((id, i) => {
    nodes.push({
      id,
      label: id,
      title: AXIOM_LABEL[id],
      kind: id.startsWith("公準") ? "postulate" : "axiom",
      x: spread(roots.length, i),
      y: Y_ROOT,
      w: 56,
    });
  });

  // 中段: 命題。
  PROPOSITIONS.forEach((id, i) => {
    nodes.push({
      id,
      label: id,
      title: AXIOM_LABEL[id],
      kind: "proposition",
      x: spread(PROPOSITIONS.length, i),
      y: Y_PROP,
      w: 56,
    });
  });

  // 下段: 系。
  COROLLARIES.forEach((c, i) => {
    nodes.push({
      id: c.id,
      label: c.id,
      title: `${c.id} ${c.theory}`,
      kind: "corollary",
      x: spread(COROLLARIES.length, i),
      y: Y_COR,
      w: 32,
    });
  });

  // エッジ: from(依存する側) → to(立脚される側)。
  const edges: { from: string; to: string }[] = [];
  for (const [prop, basis] of Object.entries(PROPOSITION_BASIS)) {
    for (const b of basis) edges.push({ from: prop, to: b });
  }
  for (const c of COROLLARIES) {
    for (const b of c.basis) edges.push({ from: c.id, to: b });
  }

  return { nodes, edges };
}

export default function AxiomGraph() {
  const { nodes, edges } = useMemo(() => buildGraph(), []);
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);

  const active = pinned ?? hover;

  const nodeById = useMemo(() => {
    const m = new Map<string, GNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  // active から到達できるノード集合(祖先=立脚先を根まで / 子孫=それに立脚する側)。
  // 系を選べば公準まで遡り、公準を選べばそれに依る系まで下る。
  const related = useMemo(() => {
    if (!active) return null;
    const up = new Set<string>();
    const down = new Set<string>();
    const walk = (id: string, dir: "up" | "down", seen: Set<string>) => {
      for (const e of edges) {
        const next = dir === "up" ? (e.from === id ? e.to : null) : e.to === id ? e.from : null;
        if (next && !seen.has(next)) {
          seen.add(next);
          walk(next, dir, seen);
        }
      }
    };
    walk(active, "up", up);
    walk(active, "down", down);
    const all = new Set<string>([active, ...up, ...down]);
    return all;
  }, [active, edges]);

  const isLit = (id: string) => !related || related.has(id);
  const edgeLit = (e: { from: string; to: string }) =>
    !related || (related.has(e.from) && related.has(e.to));

  const activeNode = active ? nodeById.get(active) : null;

  return (
    <div>
      {/* 狭い画面では横スクロール(本文を押し広げない) */}
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full min-w-[720px]"
          role="img"
          aria-label="公準・公理から命題を経て系に至る依存グラフ"
        >
          {/* 段ラベル */}
          <text x={4} y={Y_ROOT - 18} className="fill-gray-400 text-[10px]">
            公準（株式に固有の要請） / 公理（一般に自明）
          </text>
          <text x={4} y={Y_PROP - 18} className="fill-gray-400 text-[10px]">
            命題（公準から直接導かれる基本定理）
          </text>
          <text x={4} y={Y_COR - 18} className="fill-gray-400 text-[10px]">
            系（既存理論の再導出）── クリックでその系のカードへ
          </text>

          {/* エッジ(先に描いてノードの下に敷く) */}
          {edges.map((e, i) => {
            const a = nodeById.get(e.from);
            const b = nodeById.get(e.to);
            if (!a || !b) return null;
            const lit = edgeLit(e);
            // 縦方向のベジェ: 下(from)から上(to)へ緩やかに繋ぐ。
            const my = (a.y + b.y) / 2;
            const d = `M ${a.x} ${a.y - 10} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y + 10}`;
            return (
              <path
                key={i}
                d={d}
                fill="none"
                stroke={lit ? "#6366f1" : "#e5e7eb"}
                strokeWidth={lit && related ? 1.4 : 0.7}
                opacity={lit ? (related ? 0.85 : 0.28) : 0.25}
              />
            );
          })}

          {/* ノード */}
          {nodes.map((n) => {
            const s = KIND_STYLE[n.kind];
            const lit = isLit(n.id);
            const isActive = n.id === active;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                opacity={lit ? 1 : 0.2}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onClick={() => {
                  if (n.kind === "corollary") {
                    document
                      .getElementById(n.id)
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }
                  setPinned((p) => (p === n.id ? null : n.id));
                }}
                className="cursor-pointer"
              >
                <title>{n.title}</title>
                <rect
                  x={-n.w / 2}
                  y={-10}
                  width={n.w}
                  height={20}
                  rx={5}
                  fill={s.fill}
                  stroke={isActive ? "#111827" : s.stroke}
                  strokeWidth={isActive ? 2 : 1}
                />
                <text
                  x={0}
                  y={4}
                  textAnchor="middle"
                  fill={s.text}
                  className="text-[10px] font-medium"
                  style={{ pointerEvents: "none" }}
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* 選択中ノードの説明 */}
      <div className="mt-2 min-h-[2.5rem] rounded-lg bg-gray-50 px-3 py-2 text-xs">
        {activeNode ? (
          <>
            <span className="font-medium text-gray-800">{activeNode.title}</span>
            <div className="mt-0.5 text-gray-500">
              {activeNode.kind === "corollary"
                ? "この系が辿る命題・公準を根まで強調中。クリックでカードへ移動／固定解除。"
                : "これに立脚する命題・系を強調中。もう一度クリックで固定解除。"}
            </div>
          </>
        ) : (
          <span className="text-gray-400">
            ノードにホバーすると導出経路だけが浮かび上がります（クリックで固定）。
            すべての系は最終的に公準4（会計恒等式）へ遡ります。
          </span>
        )}
      </div>

      {/* 凡例 */}
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-gray-500">
        {(
          [
            ["postulate", "公準"],
            ["axiom", "公理"],
            ["proposition", "命題"],
            ["corollary", "系"],
          ] as [NodeKind, string][]
        ).map(([k, label]) => (
          <span key={k} className="flex items-center gap-1">
            <span
              className="inline-block h-2.5 w-4 rounded-sm border"
              style={{ background: KIND_STYLE[k].fill, borderColor: KIND_STYLE[k].stroke }}
            />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
