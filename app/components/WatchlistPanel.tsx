"use client";

import { useState, useEffect, useRef } from "react";
import {
  WatchlistItem,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
} from "../lib/watchlist";

interface Props {
  currentTicker: string | null;
  currentName: string | null;
  onSelect: (ticker: string) => void;
}

export default function WatchlistPanel({
  currentTicker,
  currentName,
  onSelect,
}: Props) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Hydrate from localStorage on mount
  useEffect(() => {
    setWatchlist(getWatchlist());
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  const isStarred =
    !!currentTicker && watchlist.some((item) => item.ticker === currentTicker);

  function handleStarClick() {
    if (!currentTicker) return;
    if (isStarred) {
      setWatchlist(removeFromWatchlist(currentTicker));
    } else {
      setWatchlist(addToWatchlist(currentTicker, currentName ?? currentTicker));
    }
  }

  function handleRemove(ticker: string) {
    setWatchlist(removeFromWatchlist(ticker));
  }

  function handleSelect(ticker: string) {
    onSelect(ticker);
    setDropdownOpen(false);
  }

  return (
    <div ref={containerRef} className="relative flex items-center gap-1">
      {/* Star toggle button */}
      <button
        onClick={handleStarClick}
        disabled={!currentTicker}
        title={isStarred ? "ウォッチリストから削除" : "ウォッチリストに追加"}
        className={`text-xl leading-none transition-colors disabled:opacity-30 ${
          isStarred ? "text-yellow-400" : "text-gray-300 hover:text-yellow-300"
        }`}
      >
        {isStarred ? "★" : "☆"}
      </button>

      {/* Dropdown toggle button */}
      <button
        onClick={() => setDropdownOpen((prev) => !prev)}
        title="ウォッチリストを表示"
        className="text-xs px-1.5 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600 transition-colors"
      >
        ▾
      </button>

      {/* Dropdown */}
      {dropdownOpen && (
        <div className="absolute z-50 bg-white border border-gray-200 rounded-lg shadow-lg left-0 sm:left-auto sm:right-0 top-full mt-1 w-56 max-w-[calc(100vw-2rem)] max-h-64 overflow-y-auto">
          {watchlist.length === 0 ? (
            <p className="px-3 py-3 text-sm text-gray-400 text-center">
              お気に入りなし
            </p>
          ) : (
            <ul>
              {watchlist.map((item) => (
                <li
                  key={item.ticker}
                  className="flex items-center justify-between hover:bg-blue-50 cursor-pointer px-3 py-2 text-sm"
                >
                  <span
                    className="flex-1 min-w-0"
                    onClick={() => handleSelect(item.ticker)}
                  >
                    <span className="font-medium text-gray-800">
                      {item.ticker}
                    </span>
                    <span className="ml-1.5 text-gray-500 truncate block text-xs">
                      {item.name}
                    </span>
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemove(item.ticker);
                    }}
                    title="削除"
                    className="ml-2 text-gray-400 hover:text-red-400 transition-colors text-base leading-none flex-shrink-0"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
