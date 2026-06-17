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
  /** 現在のセクションが系列変換を消費しない場合に true。グレーアウトして操作不可にする */
  disabled?: boolean;
  /** disabled 時にツールチップ表示する理由文。なぜ操作できないかをユーザーに示す。 */
  disabledReason?: string;
}

const DEFAULT_DISABLED_REASON =
  "このセクションの分析はOHLC（4本値）ベースのため、入力系列の変換は適用されません。";

export default function SeriesModeSelector({
  current,
  onChange,
  disabled = false,
  disabledReason = DEFAULT_DISABLED_REASON,
}: Props) {
  const tooltip = disabled ? disabledReason : undefined;
  return (
    <div className="flex items-center gap-1" title={tooltip}>
      <span className={`text-xs mr-1 ${disabled ? "text-gray-400" : "text-gray-500"}`}>
        入力系列:
      </span>
      {MODES.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          disabled={disabled}
          title={tooltip}
          className={`px-2.5 py-1 text-xs rounded font-medium transition-colors ${
            disabled
              ? `cursor-not-allowed opacity-40 ${
                  current === key ? "bg-emerald-600 text-white" : "bg-gray-100 text-gray-500"
                }`
              : current === key
              ? "bg-emerald-600 text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {label}
        </button>
      ))}
      {disabled && (
        <span className="text-xs text-gray-400 ml-1">（このセクションには適用されません）</span>
      )}
    </div>
  );
}
