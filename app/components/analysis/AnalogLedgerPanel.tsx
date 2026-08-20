"use client";

// アナログ予測の前向き検証台帳(改善C)。
// 今表示している予測を日付ごと凍結し、再訪のたびに「実際にその後どういう経路を辿ったか」を
// 重ねて採点する。OOS 検証(再計算バックテスト)と違い、記録した後から設定を変えられないため、
// 最も改竄されにくい証拠になる。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PricePoint } from "../../lib/types";
import { WeeklyAnalogResult } from "../../lib/weekly-analog";
import {
  AnalogLedgerEntry, AnalogLedgerEval, AnalogLedgerSettings, FreezeInput,
  buildAnalogEntries, entryKey, evaluateAnalogEntry, summarizeAnalogLedger, settingsLabel,
  exportAnalogLedger, parseImportedAnalogLedger,
} from "../../lib/analog-ledger";
import {
  loadAnalogLedgerStore, saveAnalogEntries, removeAnalogEntryStore, clearAnalogLedgerStore,
  type LedgerSource,
} from "../../lib/ledger-store";
import AnalysisGuide from "./AnalysisGuide";
import LedgerSyncBar from "./LedgerSyncBar";
import { CHART_COLORS } from "../../lib/chart-colors";

interface Props {
  rows: { ticker: string; res: WeeklyAnalogResult | null }[];
  settings: AnalogLedgerSettings;
  pricesByTicker: Record<string, PricePoint[]>;
  names?: Record<string, string>;
}

const VERDICT_META: Record<string, { label: string; color: string }> = {
  verified: { label: "確定", color: "#16a34a" },
  partial: { label: "進行中", color: "#2563eb" },
  waiting: { label: "待機", color: CHART_COLORS.neutral },
  stale: { label: "照合不可", color: "#dc2626" },
};

function fmtPct(v: number, d = 1): string {
  return isFinite(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%` : "—";
}

// 予測帯(薄青)＋予測中央値(青)に、実際に辿った経路(黒)を重ねるミニチャート。
// 台帳の主役はこの1枚——「そのとき何を予測し、実際はどう動いたか」が並ぶ。
function PathCompare({ ev, scale }: { ev: AnalogLedgerEval; scale: number }) {
  const H = ev.entry.settings.H;
  const W = 120, HT = 40, padX = 3, padY = 4;
  if (H < 1 || scale <= 0) return <span className="text-gray-500">—</span>;
  const x = (m: number) => padX + (m / H) * (W - 2 * padX);
  const clamp = (v: number) => Math.max(-scale, Math.min(scale, v));
  const y = (v: number) => HT / 2 - (clamp(v) / scale) * (HT / 2 - padY);
  const line = (arr: number[]) => arr.map((v, m) => `${m === 0 ? "M" : "L"}${x(m).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const up = ev.entry.predP75.map((v, m) => `${x(m).toFixed(1)},${y(v).toFixed(1)}`);
  const lo = ev.entry.predP25.map((v, m) => `${x(m).toFixed(1)},${y(v).toFixed(1)}`).reverse();
  return (
    <svg width={W} height={HT} className="inline-block align-middle" style={{ overflow: "visible" }}>
      <line x1={padX} y1={HT / 2} x2={W - padX} y2={HT / 2} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="2 2" />
      <path d={`M${up.join(" L")} L${lo.join(" L")} Z`} fill="rgba(37,99,235,0.12)" />
      <path d={line(ev.entry.predPath)} fill="none" stroke="#2563eb" strokeWidth={1.4} strokeDasharray="3 2" />
      {ev.actPath.length > 1 && <path d={line(ev.actPath)} fill="none" stroke="#111827" strokeWidth={1.8} />}
      {ev.actPath.length > 1 && (
        <circle cx={x(ev.actPath.length - 1)} cy={y(ev.actPath[ev.actPath.length - 1])} r={2.2} fill="#111827" />
      )}
    </svg>
  );
}

// 個別銘柄タブ(cal-weekly-analog)から1銘柄ぶんを凍結するための小さなボタン。
// 記録の一覧と採点は /portfolio の台帳に集約する——採点には全銘柄の価格系列が要り、
// 個別チャートは自分1銘柄しか持たないため、そこに一覧を置くと大半が「照合不可」になる。
export function AnalogFreezeButton({ ticker, res, settings }: { ticker: string; res: WeeklyAnalogResult | null; settings: AnalogLedgerSettings }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const disabled = !res || !ticker || busy;
  // 重複判定はサーバの UNIQUE 制約に任せる（この画面は台帳を読み込んでいないため、
  // 手元の既存キー集合を持っていない）。受理された件数が added で返る。
  const onClick = async () => {
    if (!res || !ticker || busy) return;
    setBusy(true);
    try {
      const { toAdd } = buildAnalogEntries([{ ticker, res }], settings, []);
      const r = await saveAnalogEntries(toAdd);
      setMsg(r.added > 0
        ? `${res.query.endTime} 基準の予測を凍結しました。${settings.H}営業日後に確定します（一覧と採点はポートフォリオの台帳）。`
          + (r.source === "server" ? "" : "（サーバー未接続のため、この端末にのみ保存）")
        : `この銘柄×基準日×設定は既に記録済みです。条件を変えて記録し直せないのが前向き検証の要件です。`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      <button onClick={onClick} disabled={disabled}
        title={ticker ? "今表示している予測を日付ごと凍結し、後日の実測経路と突き合わせる" : "銘柄コードが渡されていないため凍結できません"}
        className="px-3 py-1 rounded font-medium bg-emerald-600 text-white disabled:opacity-40 hover:bg-emerald-700">
        この予測を台帳に凍結
      </button>
      {msg
        ? <span className="text-[11px] text-emerald-700">{msg}</span>
        : <span className="text-[11px] text-fg-muted">記録すると後から条件を変えられません。一覧・採点はポートフォリオの「前向き検証台帳」。</span>}
    </div>
  );
}

export default function AnalogLedgerPanel({ rows, settings, pricesByTicker, names }: Props) {
  const [entries, setEntries] = useState<AnalogLedgerEntry[]>([]);
  const [source, setSource] = useState<LedgerSource>("server");
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(true); // 初回はサーバから読み込み中
  const [msg, setMsg] = useState<string | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 保存先はサーバ。到達できない場合だけ localStorage に退避し、LedgerSyncBar がその旨を開示する。
  const applyState = useCallback((s: { entries: AnalogLedgerEntry[]; source: LedgerSource; ownerId: string | null; reason?: string }) => {
    setEntries(s.entries);
    setSource(s.source);
    setOwnerId(s.ownerId);
    setReason(s.reason);
  }, []);

  useEffect(() => {
    let alive = true;
    loadAnalogLedgerStore().then((s) => {
      if (!alive) return;
      applyState(s);
      setBusy(false);
    });
    return () => { alive = false; };
  }, [applyState]);

  // 「サーバーに再接続」「引き継ぎ」からの再読み込み(イベント経由)
  const reload = useCallback(() => {
    setBusy(true);
    loadAnalogLedgerStore().then(applyState).finally(() => setBusy(false));
  }, [applyState]);

  const existingKeys = useMemo(
    () => entries.map((e) => entryKey(e.ticker, e.asOf, e.settings)),
    [entries]
  );

  const freezable = useMemo<FreezeInput[]>(
    () => rows.filter((r) => r.res).map((r) => ({ ticker: r.ticker, name: names?.[r.ticker], res: r.res! })),
    [rows, names]
  );

  const doFreeze = useCallback(async () => {
    if (freezable.length === 0 || busy) return;
    setBusy(true);
    try {
      const { toAdd, skipped } = buildAnalogEntries(freezable, settings, existingKeys);
      const r = await saveAnalogEntries(toAdd);
      applyState(r);
      const rejected = skipped + (toAdd.length - r.added);
      setMsg(r.added > 0
        ? `${r.added}件を凍結しました${rejected > 0 ? `（同一の予測 ${rejected}件はスキップ）` : ""}。結果は基準日から${settings.H}営業日後に確定します。`
          + (r.source === "server" ? "" : "（サーバー未接続のため、この端末にのみ保存）")
        : `新規はありません（同一の銘柄×基準日×設定が既に ${rejected}件 記録済み）。`);
    } finally {
      setBusy(false);
    }
  }, [freezable, settings, existingKeys, busy, applyState]);

  const evals = useMemo(() => {
    const out: AnalogLedgerEval[] = [];
    for (const e of entries) {
      const ev = evaluateAnalogEntry(e, pricesByTicker[e.ticker]);
      if (ev) out.push(ev);
    }
    // 基準日の新しい順
    out.sort((a, b) => (a.entry.asOf < b.entry.asOf ? 1 : a.entry.asOf > b.entry.asOf ? -1 : a.entry.ticker.localeCompare(b.entry.ticker)));
    return out;
  }, [entries, pricesByTicker]);

  const shown = onlyOpen ? evals.filter((e) => e.verdict !== "verified") : evals;
  const summary = useMemo(() => summarizeAnalogLedger(evals), [evals]);

  const scale = useMemo(() => {
    let mx = 0.005;
    for (const e of shown) {
      for (let m = 0; m < e.entry.predP25.length; m++) {
        mx = Math.max(mx, Math.abs(e.entry.predP25[m]), Math.abs(e.entry.predP75[m]));
      }
      for (const v of e.actPath) mx = Math.max(mx, Math.abs(v));
    }
    return mx;
  }, [shown]);

  const doExport = () => {
    const blob = new Blob([exportAnalogLedger(entries)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `analog-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  // 取り込みは元の凍結日を保つ(origin='local-import')。他所で凍結した記録の日付を
  // 今日に書き換えてしまうと、前向き検証の境界が動いて記録の意味が変わるため。
  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      setBusy(true);
      try {
        const { toAdd, skipped } = parseImportedAnalogLedger(String(reader.result ?? ""), existingKeys);
        const r = await saveAnalogEntries(toAdd, "local-import");
        applyState(r);
        setMsg(`取り込み: 追加${r.added}件 / 重複・不正スキップ${skipped + (toAdd.length - r.added)}件`);
      } finally {
        setBusy(false);
      }
    };
    reader.readAsText(file);
  };

  const doRemove = async (id: string) => {
    setBusy(true);
    try { applyState(await removeAnalogEntryStore(id)); } finally { setBusy(false); }
  };
  const doClear = async () => {
    setBusy(true);
    try {
      applyState(await clearAnalogLedgerStore());
      setConfirmClear(false);
      setMsg("台帳を空にしました。");
    } finally { setBusy(false); }
  };

  const curLabel = settingsLabel(settings);

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        OOS検証は「毎回その場で計算し直すバックテスト」なので、設定を触れば結果も動く。
        こちらは<span className="font-medium text-gray-700">今の予測を日付ごと凍結</span>し、
        <span className="font-medium text-gray-700">凍結後に到着したデータだけ</span>で採点する台帳。
        後から条件を変えられないことが、この検証の価値の源泉（臨床試験の事前登録と同じ発想）。
      </p>

      <LedgerSyncBar source={source} reason={reason} ownerId={ownerId} onReload={reload} busy={busy} />

      <div className="flex items-center gap-2 flex-wrap text-xs">
        <button onClick={doFreeze} disabled={freezable.length === 0 || busy}
          className="px-3 py-1.5 rounded font-medium bg-emerald-600 text-white disabled:opacity-40 hover:bg-emerald-700">
          今の予測を台帳に凍結（{freezable.length}銘柄）
        </button>
        <span className="text-fg-muted">設定: {curLabel}</span>
      </div>
      {msg && <div className="text-[11px] text-emerald-700">{msg}</div>}

      {evals.length === 0 ? (
        <div className="text-xs text-fg-muted">
          まだ記録がありません。上のボタンで今週の予測を凍結すると、{settings.H}営業日後から採点が始まります。
        </div>
      ) : (
        <>
          <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs space-y-1">
            <div className="text-gray-700">
              記録 {summary.nTotal}件（
              <span style={{ color: VERDICT_META.verified.color }}>確定 {summary.nVerified}</span> /
              <span style={{ color: VERDICT_META.partial.color }}> 進行中 {summary.nPartial}</span> /
              <span className="text-gray-500"> 待機 {summary.nWaiting}</span>
              {summary.nStale > 0 && <span style={{ color: VERDICT_META.stale.color }}> / 照合不可 {summary.nStale}</span>}
              ）
            </div>
            {summary.nVerified >= 1 ? (
              <div className="text-gray-700">
                確定分の成績: 方向的中 <span className="font-bold">{isFinite(summary.dirHitRate) ? `${(summary.dirHitRate * 100).toFixed(0)}%` : "—"}</span>
                <span className="mx-1.5 text-gray-500">|</span>
                帯被覆 <span className="font-bold">{isFinite(summary.coverage) ? `${(summary.coverage * 100).toFixed(0)}%` : "—"}</span><span className="text-gray-500">（名目50%）</span>
                <span className="mx-1.5 text-gray-500">|</span>
                誤差中央(実測−予測) <span className="font-bold">{fmtPct(summary.medianErr)}</span>
                <span className="mx-1.5 text-gray-500">|</span>
                高値到達 {isFinite(summary.mfeReachRate) ? `${(summary.mfeReachRate * 100).toFixed(0)}%` : "—"} / 安値到達 {isFinite(summary.maeReachRate) ? `${(summary.maeReachRate * 100).toFixed(0)}%` : "—"}
                <span className="text-gray-500">（較正なら各≒50%）</span>
                {isFinite(summary.ic) && (<><span className="mx-1.5 text-gray-500">|</span>IC <span className="font-bold">{summary.ic.toFixed(3)}</span></>)}
              </div>
            ) : (
              <div className="text-gray-500">確定した記録がまだありません（{settings.H}営業日ぶんのデータが揃うまで待つ）。</div>
            )}
            {summary.nVerified > 0 && summary.nVerified < 20 && (
              <div className="text-[11px] text-amber-700">
                確定 {summary.nVerified}件では的中率も被覆率もほぼ何も言えない（20件でも標準誤差は約11pt）。数字が固まるまで判断材料にしない。
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <label className="inline-flex items-center gap-1 cursor-pointer text-gray-600">
              <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} className="accent-blue-600" />
              未確定だけ表示
            </label>
            <span className="text-gray-500">|</span>
            <button onClick={doExport} className="px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600">エクスポート(JSON)</button>
            <button onClick={() => fileRef.current?.click()} className="px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600">インポート</button>
            <input ref={fileRef} type="file" accept="application/json" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ""; }} />
            <span className="text-gray-500">|</span>
            {confirmClear ? (
              <>
                <span className="text-red-600">全{entries.length}件を削除しますか？（サーバーからも消えます・復元不可）</span>
                <button onClick={doClear} disabled={busy}
                  className="px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-40">削除する</button>
                <button onClick={() => setConfirmClear(false)} className="px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-600">やめる</button>
              </>
            ) : (
              <button onClick={() => setConfirmClear(true)} className="px-2 py-0.5 rounded bg-gray-100 hover:bg-gray-200 text-gray-500">全削除</button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="text-[11px] w-full border-collapse">
              <thead>
                <tr className="text-gray-500">
                  <th className="text-left font-medium px-2 py-1">銘柄</th>
                  <th className="text-left font-medium px-2 py-1" title="予測の基準日＝経路の起点(0%)">基準日</th>
                  <th className="text-center font-medium px-1 py-1">状態</th>
                  <th className="text-center font-medium px-1 py-1" title="点線=凍結時の予測中央値 / 薄青帯=予測25–75% / 黒線=実際に辿った経路">予測 vs 実測</th>
                  <th className="text-right font-medium px-2 py-1">予測終値</th>
                  <th className="text-right font-medium px-2 py-1">実測</th>
                  <th className="text-center font-medium px-1 py-1" title="予測と実測の符号が一致したか">方向</th>
                  <th className="text-right font-medium px-2 py-1" title="実測が予測25–75%帯に入った日の割合(名目50%)">帯被覆</th>
                  <th className="text-center font-medium px-1 py-1" title="予測の高値到達(MFE)/安値到達(MAE)水準に実測が届いたか">高安到達</th>
                  <th className="text-left font-medium px-2 py-1" title="凍結時に根拠としていたin-sample指標">凍結時の根拠</th>
                  <th className="px-1 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((ev) => {
                  const e = ev.entry;
                  const vm = VERDICT_META[ev.verdict];
                  const disp = e.name && e.name !== e.ticker ? e.name : e.ticker;
                  return (
                    <tr key={e.id} className="border-t border-gray-100">
                      <td className="px-2 py-1">
                        <span className="font-medium text-gray-700" title={`${disp}（${e.ticker}）`}>{disp}</span>
                      </td>
                      <td className="px-2 py-1 text-gray-500 font-mono whitespace-nowrap">{e.asOf}</td>
                      <td className="px-1 py-1 text-center whitespace-nowrap">
                        <span style={{ color: vm.color }} className="font-medium">{vm.label}</span>
                        {ev.verdict !== "stale" && <span className="text-fg-muted"> {ev.daysDone}/{e.settings.H}</span>}
                      </td>
                      <td className="px-1 py-0.5 text-center align-middle">
                        {ev.verdict === "stale" ? <span className="text-gray-500">—</span> : <PathCompare ev={ev} scale={scale} />}
                      </td>
                      <td className={`px-2 py-1 text-right tabular-nums font-medium ${e.predMedian >= 0 ? "text-green-700" : "text-red-600"}`}>
                        {fmtPct(e.predMedian)}
                      </td>
                      <td className={`px-2 py-1 text-right tabular-nums font-semibold ${isFinite(ev.actFinal) ? (ev.actFinal >= 0 ? "text-green-700" : "text-red-700") : "text-fg-muted"}`}>
                        {fmtPct(ev.actFinal)}
                      </td>
                      <td className="px-1 py-1 text-center">
                        {ev.dirHit === null ? <span className="text-gray-500">—</span>
                          : ev.dirHit ? <span className="text-green-700">○</span> : <span className="text-red-500">×</span>}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                        {isFinite(ev.coverage) ? `${(ev.coverage * 100).toFixed(0)}%` : "—"}
                      </td>
                      <td className="px-1 py-1 text-center whitespace-nowrap"
                        title={`予測 高${fmtPct(e.predMfe)}/安${fmtPct(e.predMae)} → 実測 高${fmtPct(ev.actMfe)}/安${fmtPct(ev.actMae)}`}>
                        {ev.verdict === "stale" ? <span className="text-gray-500">—</span> : (
                          <>
                            {/* 到達/未到達を色だけで出さない。塗り(▲▼)=到達・中空(△▽)=未到達 */}
                            <span
                              className={ev.mfeReached ? "text-green-700" : "text-gray-500"}
                              aria-label={ev.mfeReached ? "高値目標に到達" : "高値目標に未到達"}
                            >
                              {ev.mfeReached ? "▲" : "△"}
                            </span>
                            <span
                              className={ev.maeReached ? "text-red-700" : "text-gray-500"}
                              aria-label={ev.maeReached ? "安値目標に到達" : "安値目標に未到達"}
                            >
                              {ev.maeReached ? "▼" : "▽"}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="px-2 py-1 text-fg-muted whitespace-nowrap"
                        title={`${e.label}｜凍結日 ${e.frozenAt}｜事例${e.nSelected}(実効${e.nEff})｜差${(e.diffMedian * 100).toFixed(1)}pt p=${e.diffP < 0.001 ? "<.001" : e.diffP.toFixed(3)}｜勝率${(e.winRate * 100).toFixed(0)}%｜novelty${(e.novelty * 100).toFixed(0)}%`}>
                        実効{e.nEff}/p{e.diffP < 0.001 ? "<.001" : e.diffP.toFixed(2)}
                      </td>
                      <td className="px-1 py-1 text-center">
                        <button onClick={() => doRemove(e.id)} disabled={busy}
                          title="この記録を削除（削除は前向き検証の趣旨に反するので、誤記録の訂正だけに使う）"
                          className="text-gray-300 hover:text-red-500 disabled:opacity-40">✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-fg-muted">
            ミニチャート: <span className="text-blue-600">青点線=凍結時の予測中央値</span> / 薄青帯=予測25–75% / <span className="text-gray-900">黒線=実際に辿った経路</span>。
            黒線が帯からはみ出すほど、予測は経路を捉えられていない。
          </p>
        </>
      )}

      <AnalysisGuide title="前向き検証台帳（凍結記録）の詳細">
        <p className="font-medium text-gray-700">1. なぜ台帳が必要か（OOS検証との違い）</p>
        <p>
          {"OOS検証(ウォークフォワード)は各週末で as-of 再計算するため未来リークはない。しかし"}
          <strong>{"『その設定を選んだこと自体』が過去を見た後の選択"}</strong>{"であり、探索の痕跡は完全には消えない。設定を触れば数字も動くので、後から都合の良い設定を選んで『当たっていた』と言うことが原理的に可能である。"}
          {"これに対し前向き検証は、予測を"}<strong>日付とともに固定</strong>{"し、"}<strong>{"凍結時点でまだ存在しなかったデータだけ"}</strong>{"で採点する。臨床試験の事前登録(pre-registration)と同じ発想で、"}
          <strong>{"後からパラメータを差し替えられないこと"}</strong>{"がこの検証の価値の源泉になる。"}
        </p>
        <p className="font-medium text-gray-700 mt-3">2. 何を凍結するか</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>予測経路一式</strong>: 終値の中央値パス、25–75%帯、高値到達(MFE)・安値到達(MAE)の中央値。終点1点ではなく経路を丸ごと固定するので、「途中でどこまで沈んだか」まで後から検証できる。</li>
          <li><strong>基準日(asOf)</strong>: 凍結時点の最終立会日。経路の起点(0%)。以後の採点はこの日の終値を基準に行う。</li>
          <li><strong>設定</strong>: モード/距離/窓/重み/σ正規化/プール/L・H・K/米国指数・ビン。<strong>銘柄×基準日×設定が同一の記録は二重に作れない</strong>——後から条件を変えて記録し直せると前向き検証の意味が消えるため。</li>
          <li><strong>記録の投入口は2つ</strong>: この画面のボタン（表示中の全銘柄を一括凍結）と、個別銘柄タブの「今週の軌跡アナログ比較」にある「この予測を台帳に凍結」（1銘柄ずつ）。保存先は同じで、一覧と採点はこの台帳に集約される——採点には全銘柄の価格系列が要るため。</li>
          <li><strong>凍結日はサーバが決める</strong>: 端末の時計を戻して過去の日付で凍結することはできない。同一の予測を二度記録できないことと合わせ、「後から都合よく記録し直す」道を物理的に塞いでいる。</li>
          <li><strong>凍結時の根拠</strong>: 事例数・実効n・ベースライン差と p 値・勝率・novelty。「何を見て張ったか」を残すことで、後から<em>「実効nが薄い記録ばかり外している」</em>のような診断ができる。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">3. 採点の定義</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>状態</strong>: 基準日以降に到着した立会日数 d に対し、d=0 待機 / 0&lt;d&lt;H 進行中 / d≧H 確定。確定した記録だけが成績集計の対象。<strong>照合不可</strong>は基準日が現在の価格系列に見つからない場合（期間フィルタで落ちた等）。</li>
          <li><strong>方向</strong>: sign(実測終点) = sign(予測中央値)。</li>
          <li><strong>帯被覆</strong>: 実測終値パスが予測25–75%帯に入っていた日の割合。<strong>名目は50%</strong>。集計値がこれを大きく下回れば、帯を「5割の確率で収まる範囲」として読むのは誤り。</li>
          <li><strong>高安到達</strong>: 実測MFEが予測MFE以上に届いたか(▲)、実測MAEが予測MAE以下に触れたか(▼)。中央値予測が較正されていれば<strong>それぞれ≒50%</strong>で起きる。▼が50%を大きく超えるなら、予測MAEを損切り幅に使うと想定より頻繁に刈られる。</li>
          <li><strong>誤差中央</strong>: 実測−予測 の中央値。正＝予測が控えめ、負＝予測が強気すぎ。系統的なバイアスを露出させる。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">4. 投資判断への活用</p>
        <ul className="list-disc pl-4 space-y-1">
          <li>まず<strong>凍結してから張る</strong>。台帳に載っていない予測で建てた玉は、後から「当たっていた」と言えてしまう。</li>
          <li>確定件数が積み上がったら、方向的中率よりも<strong>帯被覆と高安到達率</strong>を先に見る。方向は当たらなくても、値幅の見積もりが較正されていればストップ幅・利確目標には使える。</li>
          <li>凍結時の根拠(実効n・差p・novelty)と結果を突き合わせ、<strong>どの条件のときだけ当たるか</strong>を絞る。「実効n≧15かつnovelty低の記録だけは方向が当たる」なら、その条件を発注の足切りにする。</li>
          <li>OOS検証の数字と台帳の数字が大きく食い違うなら、OOS側が探索で膨らんでいる疑い。<strong>台帳の数字を優先する</strong>。</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">5. 注意点・限界</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>件数が全て</strong>。確定20件でも的中率の標準誤差は約11pt——50%と60%を区別できない。年単位で貯めて初めて意味を持つ。</li>
          <li>保存先はサーバで、ログイン不要の<strong>匿名キー(cookie)</strong>で紐づく。ブラウザのデータを消すとキーを失って自分からは見えなくなるので、端末を移る予定があれば「端末の引き継ぎ」からキーを控える。サーバに接続できない環境では、この端末の localStorage に退避して動く（上部にその旨が出る）。</li>
          <li>記録を削除できる以上、この台帳は<strong>自分自身への誠実さ</strong>にしか担保されない。外れた記録を消せば数字は簡単に良くなる。削除は誤記録の訂正だけに使う。</li>
          <li>全銘柄を一括凍結すると横断相関で件数が水増しされる。同一週の複数銘柄はほぼ1票と考える（独立な記録は「週数」であって「銘柄数×週数」ではない）。</li>
          <li>配当・分割で価格系列が遡及調整されると、過去に凍結した記録の実測値もわずかに変わる。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
