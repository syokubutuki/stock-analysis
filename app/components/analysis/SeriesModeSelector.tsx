"use client";

import { SeriesMode, SERIES_MODE_LABELS } from "../../lib/series-mode";

const MODES: { key: SeriesMode; label: string }[] = [
  { key: "close", label: SERIES_MODE_LABELS.close },
  { key: "open", label: SERIES_MODE_LABELS.open },
  { key: "diff", label: SERIES_MODE_LABELS.diff },
  { key: "logReturn", label: SERIES_MODE_LABELS.logReturn },
  { key: "overnightReturn", label: SERIES_MODE_LABELS.overnightReturn },
  { key: "intradayReturn", label: SERIES_MODE_LABELS.intradayReturn },
];

interface Props {
  current: SeriesMode;
  onChange: (mode: SeriesMode) => void;
  /** 現在のセクションが系列変換を消費しない場合に true。コントロールを表示しない */
  disabled?: boolean;
}

export default function SeriesModeSelector({
  current,
  onChange,
  disabled = false,
}: Props) {
  if (disabled) return null;

  return (
    <div className="flex items-center gap-1 overflow-x-auto min-w-0 w-full">
      <span className="text-xs mr-1 text-gray-500 shrink-0 whitespace-nowrap">入力系列:</span>
      {MODES.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`shrink-0 whitespace-nowrap px-2.5 py-1 text-xs rounded font-medium transition-colors ${
            current === key
              ? "bg-emerald-600 text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
