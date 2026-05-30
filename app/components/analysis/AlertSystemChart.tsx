"use client";

import { useMemo } from "react";
import { PricePoint } from "../../lib/types";
import { computeAlerts, type AlertItem } from "../../lib/alert-system";
import AnalysisGuide from "./AnalysisGuide";

interface Props { prices: PricePoint[]; }

const SEV_STYLES = {
  critical: { bg: "bg-red-50 border-red-300", text: "text-red-800", badge: "bg-red-500 text-white", icon: "!!" },
  warning: { bg: "bg-amber-50 border-amber-300", text: "text-amber-800", badge: "bg-amber-500 text-white", icon: "!" },
  info: { bg: "bg-blue-50 border-blue-300", text: "text-blue-800", badge: "bg-blue-500 text-white", icon: "i" },
};

const TYPE_LABELS: Record<AlertItem["type"], string> = {
  volatility: "ボラティリティ",
  distribution: "分布",
  regime: "レジーム",
  entropy: "情報",
  volume: "出来高",
};

export default function AlertSystemChart({ prices }: Props) {
  const alerts = useMemo(() => computeAlerts(prices), [prices]);

  if (alerts.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h3 className="font-bold text-gray-800">アラートシステム</h3>
        <div className="mt-2 p-3 bg-green-50 rounded text-xs text-green-700">
          現在のアラートはありません。市場状態は通常範囲内です。
        </div>
      </div>
    );
  }

  const criticals = alerts.filter(a => a.severity === "critical");
  const warnings = alerts.filter(a => a.severity === "warning");
  const infos = alerts.filter(a => a.severity === "info");

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-gray-800">アラートシステム</h3>
        <div className="flex gap-2 text-xs">
          {criticals.length > 0 && <span className="px-2 py-0.5 bg-red-500 text-white rounded-full font-medium">{criticals.length} 重大</span>}
          {warnings.length > 0 && <span className="px-2 py-0.5 bg-amber-500 text-white rounded-full font-medium">{warnings.length} 警告</span>}
          {infos.length > 0 && <span className="px-2 py-0.5 bg-blue-500 text-white rounded-full font-medium">{infos.length} 情報</span>}
        </div>
      </div>

      <div className="space-y-2">
        {alerts.map((alert, i) => {
          const style = SEV_STYLES[alert.severity];
          return (
            <div key={i} className={`p-3 rounded-lg border ${style.bg} text-xs`}>
              <div className="flex items-center gap-2 mb-1">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${style.badge}`}>{style.icon}</span>
                <span className="text-gray-500 font-medium">{TYPE_LABELS[alert.type]}</span>
                <span className={`font-bold ${style.text}`}>{alert.title}</span>
                {alert.date && <span className="text-gray-400 ml-auto font-mono">{alert.date}</span>}
              </div>
              <div className="flex items-center justify-between">
                <span className={style.text}>{alert.description}</span>
                <span className="font-mono font-bold ml-2">{alert.value}</span>
              </div>
            </div>
          );
        })}
      </div>

      <AnalysisGuide title="アラートシステムの詳細理論">
        <p className="font-medium text-gray-700">1. アラートの種類</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>ボラティリティスパイク</strong>: {"5日vol > 2× 60日vol。直近の急変動を検出。重大アラート。"}</li>
          <li><strong>ボラティリティ圧縮</strong>: {"5日vol < 0.5× 60日vol。低ボラ状態はブレイクアウトの前兆。警告。"}</li>
          <li><strong>分布シフト</strong>: {"20日ローリング尖度 > 5。テール（極端なリターン）が増加中。警告。"}</li>
          <li><strong>極端なリターン</strong>: {"直近リターンが3σ超。異常な価格変動。重大アラート。"}</li>
          <li><strong>出来高異常</strong>: {"直近出来高が20日平均の3倍超。大口取引やイベント。警告。"}</li>
          <li><strong>ドローダウン</strong>: {"ピークからの下落が10%超(警告)または20%超(重大)。"}</li>
          <li><strong>RSI極端値</strong>: {"RSI > 80(過熱)またはRSI < 20(売られすぎ)。警告。"}</li>
          <li><strong>ボラレジーム変化</strong>: {"5日volが20日volを直近5日でクロス。レジーム転換の初期シグナル。情報。"}</li>
        </ul>
        <p className="font-medium text-gray-700 mt-3">2. 重要度レベル</p>
        <ul className="list-disc pl-4 space-y-1">
          <li><strong>重大 (Critical)</strong>: 即座の注意が必要。ポジション調整を検討すべき。</li>
          <li><strong>警告 (Warning)</strong>: 注意深く監視。状況が悪化すればアクション。</li>
          <li><strong>情報 (Info)</strong>: 参考情報。市場状態の変化を認識するため。</li>
        </ul>
      </AnalysisGuide>
    </div>
  );
}
