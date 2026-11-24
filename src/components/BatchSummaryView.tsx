import React from 'react';
import {
  Play,
  Download,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  FolderArchive,
} from 'lucide-react';
import { QASessionItem } from '../types/asr';
import { formatSec } from '../utils/diff';
import { downloadSessionsAsZip, getPureSessionJson } from './JsonInspectorPanel';

interface BatchSummaryViewProps {
  sessions: QASessionItem[];
  onOpenSession: (id: string) => void;
  onRunSession: (id: string) => void;
  onRemoveSession: (id: string) => void;
}

export const BatchSummaryView: React.FC<BatchSummaryViewProps> = ({
  sessions,
  onOpenSession,
  onRunSession,
  onRemoveSession,
}) => {
  const handleDownloadArray = () => {
    const payload = sessions.map(getPureSessionJson);
    const jsonString = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `asr_batch_${new Date().toISOString().slice(0, 10)}_修正.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const completedCount = sessions.filter((s) => s.jobState === 'completed').length;
  const modifiedCount = sessions.filter(
    (s) => s.calibratedResult?.status === '已修正'
  ).length;
  const totalUtterances = sessions.reduce(
    (sum, s) =>
      sum + (s.calibratedResult?.corrected_json.transcripts.length ?? s.referenceJson.transcripts.length),
    0
  );

  return (
    <div className="max-w-6xl mx-auto py-8 px-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 font-display">
            批量质检汇总列表
          </h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
            <span>共 {sessions.length} 组样本</span>
            <span aria-hidden="true">·</span>
            <span>已完成 {completedCount} 组</span>
            <span aria-hidden="true">·</span>
            <span>存在修正 {modifiedCount} 组</span>
            <span aria-hidden="true">·</span>
            <span>总语句 {totalUtterances} 条</span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            disabled={sessions.length === 0}
            onClick={handleDownloadArray}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>导出合并数组 (.json)</span>
          </button>
          <button
            type="button"
            disabled={sessions.length === 0}
            onClick={() => downloadSessionsAsZip(sessions)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap shrink-0"
          >
            <FolderArchive className="w-3.5 h-3.5" />
            <span>按原格式打包导出 ZIP ({sessions.length})</span>
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-3 px-4">Session ID / 音频</th>
                <th className="py-3 px-4">质检状态</th>
                <th className="py-3 px-4 text-right">音频时长</th>
                <th className="py-3 px-4 text-right">语句数</th>
                <th className="py-3 px-4">AI 改动摘要</th>
                <th className="py-3 px-4 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {sessions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-sm text-slate-500">
                    当前队列暂无样本，请在左侧工作台导入音频与参考 JSON 或生成示例样本。
                  </td>
                </tr>
              ) : (
                sessions.map((item) => {
                  const activeJson = item.calibratedResult?.corrected_json ?? item.referenceJson;
                  const statusLabel =
                    item.jobState === 'processing'
                      ? '校准中'
                      : item.jobState === 'error'
                        ? '异常'
                        : item.calibratedResult
                          ? item.calibratedResult.status
                          : '待检';

                  return (
                    <tr key={item.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3 px-4">
                        <button
                          type="button"
                          onClick={() => onOpenSession(item.id)}
                          className="text-left group cursor-pointer"
                        >
                          <div className="font-mono text-xs font-semibold text-blue-700 group-hover:underline">
                            {item.referenceJson.session_id}
                          </div>
                          <div className="text-xs text-slate-500 truncate max-w-[220px]">
                            {item.audioName}
                          </div>
                        </button>
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap">
                        {item.jobState === 'processing' && (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            <span>{statusLabel}</span>
                          </span>
                        )}
                        {item.jobState === 'error' && (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-700">
                            <AlertCircle className="w-3.5 h-3.5" />
                            <span>{statusLabel}</span>
                          </span>
                        )}
                        {item.jobState === 'pending' && (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
                            <Clock className="w-3.5 h-3.5" />
                            <span>{statusLabel}</span>
                          </span>
                        )}
                        {item.jobState === 'completed' && item.calibratedResult && (
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                              item.calibratedResult.status === '已修正'
                                ? 'text-blue-700'
                                : 'text-emerald-700'
                            }`}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>{statusLabel}</span>
                          </span>
                        )}
                      </td>

                      <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                        {formatSec(activeJson.duration_sec)}
                      </td>

                      <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                        {activeJson.transcripts.length}
                      </td>

                      <td className="py-3 px-4 max-w-md">
                        <p className="text-xs text-slate-600 line-clamp-2">
                          {item.errorMessage
                            ? item.errorMessage
                            : item.calibratedResult?.summary ?? '等待启动音频帧级核对'}
                        </p>
                      </td>

                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onOpenSession(item.id)}
                            className="px-2.5 py-1 text-xs font-medium text-slate-700 hover:text-blue-700 hover:bg-blue-50 rounded cursor-pointer"
                          >
                            查看详情
                          </button>
                          <button
                            type="button"
                            disabled={item.jobState === 'processing'}
                            onClick={() => onRunSession(item.id)}
                            title="运行单条音频核对"
                            className="p-1.5 text-slate-600 hover:text-blue-700 hover:bg-blue-50 rounded disabled:opacity-40 cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onRemoveSession(item.id)}
                            title="从队列移除"
                            className="p-1.5 text-slate-400 hover:text-rose-700 hover:bg-rose-50 rounded cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
