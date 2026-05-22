"use client";

import { useState } from "react";

interface Props {
  title: string;
  children: React.ReactNode;
}

export default function AnalysisGuide({ title, children }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3 border-t border-gray-100 pt-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        <span
          className="inline-block transition-transform duration-200"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
        {title}
      </button>
      {open && (
        <div className="mt-2 text-xs text-gray-600 leading-relaxed space-y-2 bg-gray-50 rounded p-3">
          {children}
        </div>
      )}
    </div>
  );
}
