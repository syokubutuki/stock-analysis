"use client";

import { useState } from "react";
import Link from "next/link";

const MAX_LEN = 2000;

export default function FeedbackForm() {
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const trimmed = comment.trim();
  const tooLong = comment.length > MAX_LEN;
  const canSubmit = trimmed.length > 0 && !tooLong && status !== "sending";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setStatus("sending");
    setErrorMsg("");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "送信に失敗しました");
      }
      setStatus("done");
      setComment("");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "送信に失敗しました");
    }
  }

  if (status === "done") {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 text-center space-y-4">
        <div className="text-2xl">🙏</div>
        <p className="text-gray-800 font-medium">ご意見ありがとうございました。</p>
        <p className="text-sm text-gray-500">
          いただいた内容は今後の機能改善の参考にさせていただきます。
        </p>
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            onClick={() => setStatus("idle")}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700"
          >
            続けて投稿する
          </button>
          <Link
            href="/"
            className="px-5 py-2 border border-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-50"
          >
            分析に戻る
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
      <div>
        <label htmlFor="feedback-comment" className="block text-sm font-medium text-gray-700 mb-2">
          ご意見・ご要望
        </label>
        <textarea
          id="feedback-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={8}
          placeholder="追加してほしい分析機能、使いにくい点、バグの報告など、自由にご記入ください。"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex items-center justify-between mt-1">
          <span className={`text-xs ${tooLong ? "text-red-500" : "text-gray-400"}`}>
            {comment.length} / {MAX_LEN} 文字
          </span>
          {status === "error" && (
            <span className="text-xs text-red-500">{errorMsg}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          className="px-5 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {status === "sending" ? "送信中..." : "送信する"}
        </button>
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-700">
          分析に戻る
        </Link>
      </div>

      <p className="text-xs text-gray-400">
        ※ 入力内容は機能改善の目的にのみ利用します。個人を特定する情報の入力は不要です。
      </p>
    </form>
  );
}
