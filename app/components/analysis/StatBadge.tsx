"use client";

// アノマリー系分析で共通利用する有意性バッジ。
// n(標本数)・p値・有意フラグから「有意(緑)/参考(灰)」を一目で示す。
// n<30 もしくは非有意なら灰色で「参考」と明示し、過剰解釈を防ぐ。

interface Props {
  n: number;
  p: number; // FDR補正後を想定
  significant: boolean;
  minN?: number;
}

export default function StatBadge({ n, p, significant, minN = 30 }: Props) {
  const reliable = significant && n >= minN;
  const cls = reliable
    ? "bg-green-100 text-green-700 border-green-300"
    : "bg-gray-100 text-gray-500 border-gray-300";
  const labelText = reliable ? "有意" : n < minN ? "参考(n小)" : "参考";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
      title={`n=${n} / p(FDR)=${p < 0.001 ? "<0.001" : p.toFixed(3)}`}
    >
      {labelText}
      <span className="opacity-70">p={p < 0.001 ? "<.001" : p.toFixed(3)}</span>
    </span>
  );
}
