"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Page error:", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg border border-red-200 p-6 max-w-lg w-full space-y-4">
        <h2 className="text-lg font-bold text-red-700">エラーが発生しました</h2>
        <pre className="text-xs bg-red-50 p-3 rounded overflow-auto max-h-40 text-red-800">
          {error.message}
        </pre>
        {error.stack && (
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer">スタックトレース</summary>
            <pre className="mt-2 bg-gray-50 p-2 rounded overflow-auto max-h-60">
              {error.stack}
            </pre>
          </details>
        )}
        <button
          onClick={reset}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
        >
          再試行
        </button>
      </div>
    </div>
  );
}
