"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import {
  DOMAIN_MIGRATION_PATH,
  LEGACY_HOST,
  LEGACY_ORIGIN,
  SITE_HOST,
} from "../lib/site-url";

function subscribe() {
  return () => undefined;
}

export default function DomainMigrationNotice() {
  const hostname = useSyncExternalStore(
    subscribe,
    () => window.location.hostname,
    () => ""
  );

  if (hostname !== LEGACY_HOST && hostname !== SITE_HOST) return null;

  const isLegacyHost = hostname === LEGACY_HOST;
  const migrationUrl = isLegacyHost
    ? DOMAIN_MIGRATION_PATH
    : `${LEGACY_ORIGIN}${DOMAIN_MIGRATION_PATH}`;

  return (
    <aside className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-950">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <span>
          {isLegacyHost
            ? `株原論は ${SITE_HOST} へ移行しました。`
            : "旧サイトに台帳や表示設定がある方は、移行できます。"}
        </span>
        <Link
          href={migrationUrl}
          className="font-semibold text-blue-700 underline hover:text-blue-900"
        >
          台帳と設定を新ドメインへ引き継ぐ
        </Link>
      </div>
    </aside>
  );
}
