"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { InstrumentType } from "../lib/instruments";

interface Suggestion {
  symbol: string;
  ticker: string;
  name: string;
  type: InstrumentType;
  market: string;
  currency?: string;
  priceSupported: boolean;
  source: "catalog" | "yahoo";
}

interface SearchResponse {
  quotes?: Suggestion[];
  degraded?: boolean;
  error?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (ticker: string) => void;
  loading: boolean;
}

const TYPE_LABELS: Record<InstrumentType, string> = {
  "jp-stock": "日本株", "us-stock": "米国株", etf: "ETF", fund: "投信", index: "指数",
};

const TYPE_STYLES: Record<InstrumentType, string> = {
  "jp-stock": "bg-blue-50 text-blue-700",
  "us-stock": "bg-indigo-50 text-indigo-700",
  etf: "bg-emerald-50 text-emerald-700",
  fund: "bg-amber-50 text-amber-700",
  index: "bg-purple-50 text-purple-700",
};

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase();
}

export default function TickerSearchInput({ value, onChange, onSubmit, loading }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [unsupportedMessage, setUnsupportedMessage] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const skipSearchRef = useRef(false);
  const focusedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const listboxId = useId();

  useEffect(() => {
    if (skipSearchRef.current) {
      skipSearchRef.current = false;
      return;
    }
    abortRef.current?.abort();
    const q = value.trim();
    if (q.length < 2) return;
    if (!focusedRef.current) return;

    const handle = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      setSearching(true);
      setSearchError(null);
      setUnsupportedMessage(null);
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        const json = await response.json() as SearchResponse;
        if (!response.ok) throw new Error(json.error || "検索に失敗しました");
        setSuggestions(json.quotes ?? []);
        setDegraded(Boolean(json.degraded));
        setOpen(true);
        setHighlight(-1);
      } catch (error) {
        if (controller.signal.aborted) return;
        setSuggestions([]);
        setDegraded(false);
        setSearchError(error instanceof Error ? error.message : "検索に失敗しました");
        setOpen(true);
      } finally {
        if (abortRef.current === controller) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [value]);

  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      abortRef.current?.abort();
    };
  }, []);

  const effectiveOpen = open && value.trim().length >= 2;

  const selectSuggestion = useCallback((suggestion: Suggestion) => {
    skipSearchRef.current = true;
    onChange(suggestion.ticker);
    setOpen(false);
    setSuggestions([]);
    setHighlight(-1);
    // 現在のカタログは全件trueだが、検索APIが将来「検索可能・価格未対応」の
    // 銘柄を返せる契約を保つため、防御的な表示としてこの分岐を残す。
    if (!suggestion.priceSupported) {
      setUnsupportedMessage(`${suggestion.name}の価格取得は現在調整中です。`);
      return;
    }
    setUnsupportedMessage(null);
    onSubmit(suggestion.ticker);
  }, [onChange, onSubmit]);

  const handleSubmit = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (effectiveOpen && highlight >= 0 && highlight < suggestions.length) {
      selectSuggestion(suggestions[highlight]);
      return;
    }
    const input = normalized(value);
    const codeMatch = suggestions.find((item) =>
      normalized(item.ticker) === input || normalized(item.symbol) === input,
    );
    if (codeMatch) {
      selectSuggestion(codeMatch);
      return;
    }
    if (/^[A-Z0-9.^=-]+$/.test(input)) {
      setOpen(false);
      setUnsupportedMessage(null);
      onSubmit(input);
    } else if (input) {
      setOpen(true);
      setUnsupportedMessage("会社名や通称で検索した場合は、候補から銘柄を選択してください。");
    }
  }, [effectiveOpen, highlight, suggestions, value, onSubmit, selectSuggestion]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!effectiveOpen || suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((current) => (current + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
    }
  }, [effectiveOpen, suggestions]);

  const showStatus = effectiveOpen && suggestions.length === 0;

  return (
    <div ref={containerRef} className="relative">
      <form onSubmit={handleSubmit} className="flex items-center gap-2 sm:gap-3">
        <div className="relative">
          <input
            name="ticker"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={effectiveOpen}
            aria-controls={listboxId}
            aria-activedescendant={highlight >= 0 ? `${listboxId}-${highlight}` : undefined}
            autoComplete="off"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setUnsupportedMessage(null);
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => {
              focusedRef.current = true;
              if (value.trim().length >= 2 && (suggestions.length > 0 || searchError)) setOpen(true);
            }}
            onBlur={() => { focusedRef.current = false; }}
            placeholder="コード・会社名・指数名"
            className="w-44 rounded-lg border border-gray-300 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-blue-500 sm:w-72 sm:px-4"
          />
          {searching && value.trim().length >= 2 && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400" aria-label="検索中">…</span>
          )}
        </div>
        <button type="submit" disabled={loading} className="shrink-0 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 sm:px-5">
          {loading ? "取得中..." : "分析開始"}
        </button>
      </form>

      {unsupportedMessage && <p className="mt-1 max-w-sm text-xs text-amber-700" role="status">{unsupportedMessage}</p>}

      {effectiveOpen && suggestions.length > 0 && (
        <ul id={listboxId} role="listbox" className="absolute left-0 top-full z-50 mt-1 max-h-80 w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {suggestions.map((suggestion, index) => (
            <li
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === highlight}
              key={`${suggestion.source}:${suggestion.symbol}`}
              onMouseDown={(event) => { event.preventDefault(); selectSuggestion(suggestion); }}
              onMouseEnter={() => setHighlight(index)}
              className={`cursor-pointer px-3 py-2.5 text-sm ${index === highlight ? "bg-blue-50" : "hover:bg-gray-50"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 font-medium text-gray-800">{suggestion.name}</span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${TYPE_STYLES[suggestion.type]}`}>{TYPE_LABELS[suggestion.type]}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-gray-500">
                <span className="font-mono text-gray-700">{suggestion.ticker}</span>
                <span>{suggestion.market}</span>
                {!suggestion.priceSupported && <span className="text-amber-700">価格取得は調整中</span>}
              </div>
            </li>
          ))}
          {degraded && (
            <li className="border-t border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700" role="status">
              外部検索を利用できないため、登録済み銘柄のみ表示しています。
            </li>
          )}
        </ul>
      )}

      {showStatus && (
        <div className="absolute left-0 top-full z-50 mt-1 w-96 max-w-[calc(100vw-2rem)] rounded-lg border bg-white px-3 py-2 text-xs shadow-lg" role="status">
          {searching ? <span className="text-gray-500">検索中です…</span> : searchError ? <span className="text-red-600">{searchError}。コードは直接入力できます。</span> : degraded ? <span className="text-amber-700">外部検索を利用できないため、登録済み銘柄のみ表示しています。</span> : <span className="text-gray-500">候補がありません。コードを直接入力できます。</span>}
        </div>
      )}
    </div>
  );
}
