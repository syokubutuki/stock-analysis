"use client";

// 日中足コンポーネント群で共有するUI部品とCanvas補助。
// 既存 HighLowTimingChart のローカル関数を横断利用できるよう切り出したもの。

export function initCanvas(canvas: HTMLCanvasElement, height: number) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  const width = parent.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, width, height);
  return { ctx, width, height };
}

export function fmtPct(x: number, d = 1): string {
  return `${(x * 100).toFixed(d)}%`;
}
export function fmtSignedPct(x: number, d = 2): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
}

export const INTRADAY_INTERVALS = [
  { value: "5m", label: "5分足", note: "直近約60日" },
  { value: "15m", label: "15分足", note: "直近約60日" },
  { value: "30m", label: "30分足", note: "直近約60日" },
  { value: "60m", label: "60分足", note: "直近約2年" },
] as const;

export function IntervalButtons({
  value, onChange, options = INTRADAY_INTERVALS as readonly { value: string; label: string; note?: string }[],
}: {
  value: string;
  onChange: (v: string) => void;
  options?: readonly { value: string; label: string; note?: string }[];
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((iv) => (
        <button
          key={iv.value}
          onClick={() => onChange(iv.value)}
          title={iv.note}
          className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
            value === iv.value ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {iv.label}
        </button>
      ))}
    </div>
  );
}

export function ViewTabs<T extends string>({
  value, onChange, views,
}: {
  value: T;
  onChange: (v: T) => void;
  views: { value: T; label: string }[];
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {views.map((v) => (
        <button
          key={v.value}
          onClick={() => onChange(v.value)}
          className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
            value === v.value ? "bg-gray-800 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

export function LoadingError({ loading, error }: { loading: boolean; error: string | null }) {
  return (
    <>
      {loading && <div className="text-sm text-gray-400 py-8 text-center">日中足を取得中...</div>}
      {error && <div className="bg-amber-50 text-amber-700 rounded-lg p-3 text-sm">{error}</div>}
    </>
  );
}

export function StatCell({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "neutral" }) {
  const c = tone === "up" ? "text-green-600" : tone === "down" ? "text-red-600" : "text-gray-800";
  return (
    <div className="bg-gray-50 rounded p-2">
      <div className="text-gray-500">{label}</div>
      <div className={`font-bold ${c}`}>{value}</div>
    </div>
  );
}

// 時刻軸ラベル描画（ビンのstartMinute配列から、ラベルが密なら間引く）。
export function drawTimeAxisLabels(
  ctx: CanvasRenderingContext2D,
  labels: string[],
  ml: number, slot: number, y: number
) {
  const n = labels.length;
  ctx.fillStyle = "#6b7280";
  ctx.font = "8px sans-serif";
  ctx.textAlign = "center";
  const every = n > 14 ? Math.ceil(n / 12) : 1;
  for (let i = 0; i < n; i++) {
    if (i % every !== 0) continue;
    ctx.fillText(labels[i], ml + i * slot + slot / 2, y);
  }
}

// 注意書き（遅延・サンプル）共通フッタ。
export function IntradayCaveat({ extra }: { extra?: string }) {
  return (
    <p className="text-xs text-gray-400 leading-relaxed">
      {"※ Yahoo日中足は約15分遅延・取得期間に上限あり（5/15/30分足≈60日、60分足≈2年）。サンプルが薄いため有意性とともに参考程度に。"}
      {extra ? ` ${extra}` : ""}
    </p>
  );
}
