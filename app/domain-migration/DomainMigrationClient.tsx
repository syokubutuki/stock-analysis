"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DOMAIN_MIGRATION_CHANNEL,
  applyDomainMigrationStorage,
  collectDomainMigrationPayload,
  isDomainMigrationMessage,
  validateDomainMigrationPayload,
  type DomainMigrationMessage,
} from "../lib/domain-migration";
import {
  adoptOwnerIdForDomainMigration,
  fetchOwnerId,
  importDomainMigratedLedgers,
} from "../lib/ledger-store";
import {
  DOMAIN_MIGRATION_PATH,
  LEGACY_HOST,
  LEGACY_ORIGIN,
  SITE_HOST,
  SITE_ORIGIN,
} from "../lib/site-url";

type Status = "loading" | "ready" | "sending" | "receiving" | "complete" | "error";

function message(type: DomainMigrationMessage["type"], extra: Record<string, unknown> = {}): DomainMigrationMessage {
  return { channel: DOMAIN_MIGRATION_CHANNEL, type, ...extra } as DomainMigrationMessage;
}

function sourcePeerOrigin(): string {
  return window.location.hostname === "localhost" ? window.location.origin : LEGACY_ORIGIN;
}

function targetPeerOrigin(): string {
  return window.location.hostname === "localhost" ? window.location.origin : SITE_ORIGIN;
}

export default function DomainMigrationClient() {
  const [status, setStatus] = useState<Status>("loading");
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [detail, setDetail] = useState("");
  const transferWindow = useRef<Window | null>(null);
  const receiving = useSyncExternalStore(
    () => () => undefined,
    () => {
      const params = new URLSearchParams(window.location.search);
      return (
        window.location.hostname === SITE_HOST ||
        (window.location.hostname === "localhost" && params.get("mode") === "receive")
      );
    },
    () => false
  );
  const sourceAllowed = useSyncExternalStore(
    () => () => undefined,
    () => window.location.hostname === LEGACY_HOST || window.location.hostname === "localhost",
    () => true
  );
  const hasOpener = useSyncExternalStore(
    () => () => undefined,
    () => !!window.opener,
    () => false
  );

  useEffect(() => {
    if (receiving) {
      if (window.opener) {
        window.opener.postMessage(message("ready"), sourcePeerOrigin());
      }
      return;
    }

    if (!sourceAllowed) return;

    fetchOwnerId()
      .then((id) => {
        if (!id) throw new Error("匿名キーを取得できませんでした");
        setOwnerId(id);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        setStatus("error");
        setDetail(error instanceof Error ? error.message : "匿名キーを取得できませんでした");
      });
  }, [receiving, sourceAllowed]);

  useEffect(() => {
    const onMessage = async (event: MessageEvent<unknown>) => {
      if (!isDomainMigrationMessage(event.data)) return;

      if (receiving) {
        const sourceOrigin = sourcePeerOrigin();
        if (event.origin !== sourceOrigin || event.source !== window.opener || event.data.type !== "payload") return;
        if (!validateDomainMigrationPayload(event.data.payload)) {
          window.opener?.postMessage(message("error", { message: "移行データを検証できませんでした" }), sourceOrigin);
          setStatus("error");
          setDetail("移行データを検証できませんでした。");
          return;
        }
        try {
          setStatus("receiving");
          const importedKeys = applyDomainMigrationStorage(event.data.payload);
          const adopted = await adoptOwnerIdForDomainMigration(event.data.payload.ownerId);
          if (!adopted.ok) throw new Error(adopted.error ?? "匿名キーを引き継げませんでした");
          await importDomainMigratedLedgers();
          setStatus("complete");
          setDetail(`${importedKeys}件のブラウザ設定と台帳所有者を引き継ぎました。`);
          window.opener?.postMessage(message("complete", { importedKeys }), sourceOrigin);
        } catch (error) {
          const text = error instanceof Error ? error.message : "引き継ぎに失敗しました";
          setStatus("error");
          setDetail(text);
          window.opener?.postMessage(message("error", { message: text }), sourceOrigin);
        }
        return;
      }

      const targetOrigin = targetPeerOrigin();
      if (event.origin !== targetOrigin || event.source !== transferWindow.current) return;
      if (event.data.type === "ready" && ownerId) {
        try {
          const payload = collectDomainMigrationPayload(ownerId);
          transferWindow.current?.postMessage(message("payload", { payload }), targetOrigin);
        } catch (error) {
          setStatus("error");
          setDetail(error instanceof Error ? error.message : "移行データを作成できませんでした");
        }
      } else if (event.data.type === "complete") {
        setStatus("complete");
        setDetail(`${event.data.importedKeys}件のブラウザ設定と台帳所有者を新ドメインへ引き継ぎました。`);
      } else if (event.data.type === "error") {
        setStatus("error");
        setDetail(event.data.message);
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [ownerId, receiving]);

  const start = useCallback(() => {
    if (!ownerId) return;
    setStatus("sending");
    setDetail("新ドメインからの応答を待っています…");
    const target =
      window.location.hostname === "localhost"
        ? `${window.location.origin}${DOMAIN_MIGRATION_PATH}?mode=receive`
        : `${SITE_ORIGIN}${DOMAIN_MIGRATION_PATH}?receive=1`;
    const opened = window.open(target, "kabugenron-domain-migration", "popup,width=720,height=760");
    if (!opened) {
      setStatus("error");
      setDetail("ポップアップがブロックされました。このサイトのポップアップを許可して再試行してください。");
      return;
    }
    transferWindow.current = opened;
  }, [ownerId]);

  return (
    <main
      className="mx-auto min-h-[70vh] max-w-2xl px-4 py-12"
      data-migration-mode={receiving ? "receiver" : "source"}
      data-migration-status={status}
    >
      <h1 className="text-2xl font-bold text-gray-900">新ドメインへのデータ引き継ぎ</h1>
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        {receiving ? (
          <p className="text-sm leading-7 text-gray-700">
            {status === "complete"
              ? detail
              : status === "error"
                ? detail
                : hasOpener
                  ? "旧サイトから台帳と設定を受信しています。このウィンドウを閉じないでください。"
                  : `旧サイト（${LEGACY_HOST}）の移行ページから開いてください。`}
          </p>
        ) : !sourceAllowed ? (
          <p className="text-sm text-red-700">このページは旧サイトまたは新サイトから開いてください。</p>
        ) : (
          <>
            <p className="text-sm leading-7 text-gray-700">
              匿名台帳、未同期のローカル台帳、ウォッチリスト、銘柄・表示設定を
              <strong className="mx-1">{SITE_HOST}</strong>へ安全にコピーします。
              匿名キーをURLへ載せることはありません。
            </p>
            <p className="mt-3 text-xs text-gray-500">
              匿名キー: <code className="select-all rounded bg-gray-100 px-1.5 py-0.5">{ownerId ?? "取得中…"}</code>
            </p>
            <button
              type="button"
              onClick={start}
              disabled={status === "loading" || status === "sending" || !ownerId}
              className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === "sending" ? "新ドメインへ接続中…" : "新ドメインへ引き継ぐ"}
            </button>
            {detail && (
              <p className={`mt-4 text-sm ${status === "error" ? "text-red-700" : "text-emerald-700"}`}>{detail}</p>
            )}
            {status === "complete" && (
              <a href={SITE_ORIGIN} className="mt-4 inline-block text-sm font-semibold text-blue-700 underline">
                {SITE_HOST} を開く
              </a>
            )}
          </>
        )}
      </div>
      <p className="mt-4 text-xs leading-6 text-gray-500">
        旧サイトのデータは自動削除しません。問題があれば旧ドメインの復元キーで元に戻せます。
      </p>
    </main>
  );
}
