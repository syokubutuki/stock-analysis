"use client";

import { PeriodKey } from "../../hooks/useAnalysisData";

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "1m", label: "1M" },
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "1y", label: "1Y" },
  { key: "2y", label: "2Y" },
  { key: "3y", label: "3Y" },
  { key: "5y", label: "5Y" },
  { key: "10y", label: "10Y" },
];

interface Props {
  current: PeriodKey;
  onChange: (period: PeriodKey) => void;
}

export default function PeriodSelector({ current, onChange }: Props) {
  return (
    <div className="flex gap-1">
      {PERIODS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          className={`px-3 py-1 text-sm rounded font-medium transition-colors ${
            current === key
              ? "bg-blue-600 text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
