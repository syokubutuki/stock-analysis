"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Suggestion {
  symbol: string;
  ticker: string;
  name: string;
  exchange: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (ticker: string) => void;
  loading: boolean;
}

/**
 * 銘柄コードだけでなく社名（「トヨタ」「ソフトバンク」）でも検索できる入力欄。
 * 入力をデバウンスして /api/search を叩き、候補をドロップダウン表示する。
 * 候補選択（クリック / ↑↓+Enter）でそのまま分析を開始する。
 */
export default function TickerSearchInput({ value, onChange, onSubmit, loading }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [searching, setSearching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const skipSearchRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // 入力をデバウンスして検索。候補選択直後の value 変更では再検索しない。
  useEffect(() => {
    if (skipSearchRef.current) {
      skipSearchRef.current = false;
      return;
    }
    const q = value.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: ctrl.signal,
        });
        const json = await res.json();
        setSuggestions(json.quotes ?? []);
        setOpen(true);
        setHighlight(-1);
      } catch {
        // abort / ネットワークエラーは無視（手入力での分析は可能）
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [value]);

  // 外側クリックで閉じる
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const selectSuggestion = useCallback(
    (s: Suggestion) => {
      skipSearchRef.current = true;
      onChange(s.ticker);
      setOpen(false);
      setSuggestions([]);
      setHighlight(-1);
      onSubmit(s.ticker);
    },
    [onChange, onSubmit]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (open && highlight >= 0 && highlight < suggestions.length) {
        selectSuggestion(suggestions[highlight]);
        return;
      }
      const t = value.trim();
      if (t) {
        setOpen(false);
        onSubmit(t);
      }
    },
    [open, highlight, suggestions, value, onSubmit, selectSuggestion]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!open || suggestions.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    },
    [open, suggestions]
  );

  return (
    <div ref={containerRef} className="relative">
      <form onSubmit={handleSubmit} className="flex items-center gap-3">
        <div className="relative">
          <input
            name="ticker"
            type="text"
            autoComplete="off"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              if (suggestions.length > 0) setOpen(true);
            }}
            placeholder="コード or 社名 (例: 9984, トヨタ, AAPL)"
            className="px-4 py-2 border border-gray-300 rounded-lg text-base w-52 sm:w-72 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {searching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
              …
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={loading}
          className="px-5 py-2 bg-blue-600 text-white rounded-lg font-medium whitespace-nowrap shrink-0 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "取得中..." : "分析開始"}
        </button>
      </form>

      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 left-0 top-full mt-1 w-72 max-w-[calc(100vw-2rem)] max-h-72 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
          {suggestions.map((s, i) => (
            <li
              key={s.symbol}
              // onMouseDown + preventDefault で input の blur より先に選択を確定する
              onMouseDown={(e) => {
                e.preventDefault();
                selectSuggestion(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`px-3 py-2 cursor-pointer text-sm flex items-center justify-between gap-2 ${
                i === highlight ? "bg-blue-50" : "hover:bg-gray-50"
              }`}
            >
              <span className="min-w-0 flex items-baseline gap-2">
                <span className="font-medium text-gray-800 shrink-0">{s.ticker}</span>
                <span className="text-gray-500 text-xs truncate">{s.name}</span>
              </span>
              {s.exchange && (
                <span className="shrink-0 text-[10px] text-gray-400">{s.exchange}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
