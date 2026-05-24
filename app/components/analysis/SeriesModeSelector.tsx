"use client";

import { SeriesMode, SERIES_MODE_LABELS } from "../../lib/series-mode";

const MODES: { key: SeriesMode; label: string }[] = [
  { key: "close", label: SERIES_MODE_LABELS.close },
  { key: "diff", label: SERIES_MODE_LABELS.diff },
  { key: "logReturn", label: SERIES_MODE_LABELS.logReturn },
];

interface Props {
  current: SeriesMode;
  onChange: (mode: SeriesMode) => void;
}

export default function SeriesModeSelector({ current, onChange }: Props) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-gray-500 mr-1">入力系列:</span>
      {MODES.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
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
