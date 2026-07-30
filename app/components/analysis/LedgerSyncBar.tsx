"use client";

// 前向き検証台帳（エッジ／アナログ）の共通ヘッダ。保存先がサーバかこの端末かを常に開示し、
// 端末を移るための復元キーを出す。
//
// 「どこに保存されているか」を隠さないのは機能の一部である。前向き検証は年単位で記録が
// 積み上がって初めて意味を持つので、利用者が「消える保存先」に気づけないまま
// 半年ぶんの記録を失う事態は、この分析そのものを無価値にする。

import { useCallback, useState } from "react";
import { adoptOwnerId, resetServerProbe, type LedgerSource } from "../../lib/ledger-store";

interface Props {
  source: LedgerSource;
  reason?: string;
  ownerId: string | null;
  /** 台帳の再読み込み（再試行・引き継ぎ後に呼ぶ） */
  onReload: () => void;
  busy?: boolean;
}

export default function LedgerSyncBar({ source, reason, ownerId, onReload, busy }: Props) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const retry = useCallback(() => {
    resetServerProbe();
    setMsg(null);
    onReload();
  }, [onReload]);

  const doCopy = useCallback(async () => {
    if (!ownerId) return;
    try {
      await navigator.clipboard.writeText(ownerId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMsg("コピーできませんでした。キーを選択して手動でコピーしてください。");
    }
  }, [ownerId]);

  const doAdopt = useCallback(async () => {
    const v = input.trim();
    if (!v) return;
    const r = await adoptOwnerId(v);
    if (r.ok) {
      setMsg("引き継ぎました。台帳を読み直します。");
      setInput("");
      onReload();
    } else {
      setMsg(r.error ?? "引き継ぎに失敗しました");
    }
  }, [input, onReload]);

  const onServer = source === "server";

  return (
    <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[11px] space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 border font-medium ${
            onServer
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-amber-50 text-amber-700 border-amber-200"
          }`}
        >
          <span aria-hidden>{onServer ? "●" : "▲"}</span>
          {onServer ? "保存先: サーバー" : "保存先: このブラウザのみ"}
        </span>
        <span className="text-gray-500">
          {onServer
            ? "ブラウザのデータを消しても、別のPCから見ても、凍結した記録は残ります。"
            : reason ?? "この端末のデータを消すと記録も消えます。"}
        </span>
        {!onServer && (
          <button onClick={retry} disabled={busy} className="px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600 disabled:opacity-40">
            サーバーに再接続
          </button>
        )}
        <button onClick={() => setOpen((v) => !v)} className="ml-auto text-gray-500 hover:text-gray-700 underline">
          {open ? "閉じる" : "端末の引き継ぎ"}
        </button>
      </div>

      {open && (
        <div className="border-t border-gray-100 pt-1.5 space-y-1.5">
          <div className="text-gray-500">
            台帳はログイン不要の<span className="font-medium text-gray-700">匿名キー</span>で紐づいています。
            別のPCやスマホで同じ台帳を見るには、下のキーをそちらの画面に貼り付けてください。
            キーを知る人は誰でもこの台帳を読み書きできるので、他人に渡さないこと。
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-gray-500">この端末のキー:</span>
            {ownerId ? (
              <>
                <code className="font-mono bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 select-all">{ownerId}</code>
                <button onClick={doCopy} className="px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600">
                  {copied ? "コピーしました" : "コピー"}
                </button>
              </>
            ) : (
              <span className="text-gray-400">サーバー未接続のため発行されていません</span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-gray-500">別のキーに引き継ぐ:</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="border border-gray-200 rounded px-1.5 py-0.5 font-mono w-[19rem] max-w-full"
            />
            <button
              onClick={doAdopt}
              disabled={!input.trim() || busy}
              className="px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              引き継ぐ
            </button>
          </div>
          <div className="text-gray-400">
            引き継ぐと、この端末に紐づいていた台帳は画面から見えなくなります（サーバー上の記録は消えません。元のキーを入れれば戻せます）。
          </div>
          {msg && <div className="text-blue-700">{msg}</div>}
        </div>
      )}
    </div>
  );
}
