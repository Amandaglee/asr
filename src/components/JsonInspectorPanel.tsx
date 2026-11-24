import React, { useMemo, useState } from 'react';
import JSZip from 'jszip';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FolderArchive,
  ShieldCheck,
} from 'lucide-react';
import { QASessionItem, TranscriptSession } from '../types/asr';
import { validateTranscriptSession } from '../utils/validation';

interface JsonInspectorPanelProps {
  activeSession: QASessionItem | null;
  allSessions: QASessionItem[];
  onSelectUtterance?: (id: number) => void;
}

export function getPureSessionJson(session: QASessionItem): TranscriptSession {
  const src = session.calibratedResult?.corrected_json ?? session.referenceJson;
  return {
    ...src,
    session_id: src.session_id,
    duration_sec: src.duration_sec,
    transcripts: src.transcripts.map((u) => ({
      ...u,
      utterance_id: u.utterance_id,
      role: u.role,
      start: u.start,
      end: u.end,
      text: u.text,
    })),
  };
}

export function buildCorrectedJsonFilename(session: QASessionItem): string {
  const rawName =
    session.sourceJsonName?.trim() ||
    (session.referenceJson.session_id && session.referenceJson.session_id !== 'session_001'
      ? session.referenceJson.session_id.trim()
      : session.audioName?.trim()) ||
    'session';
  const baseName = rawName.replace(/\.[^.]+$/, '') || 'session';
  const finalBase = baseName.endsWith('_修正') ? baseName : `${baseName}_修正`;
  return `${finalBase}.json`;
}

export async function downloadSessionsAsZip(sessions: QASessionItem[]) {
  const zip = new JSZip();
  const usedNames = new Set<string>();

  for (const s of sessions) {
    const pure = getPureSessionJson(s);
    let fileName = buildCorrectedJsonFilename(s);
    if (usedNames.has(fileName)) {
      const base = fileName.replace(/\.json$/i, '');
      fileName = `${base}_${usedNames.size + 1}.json`;
    }
    usedNames.add(fileName);
    zip.file(fileName, JSON.stringify(pure, null, 2));
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `asr_calibrated_${new Date().toISOString().slice(0, 10)}_修正.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const JsonInspectorPanel: React.FC<JsonInspectorPanelProps> = ({
  activeSession,
  allSessions,
  onSelectUtterance,
}) => {
  const [scope, setScope] = useState<'active' | 'batch'>('active');
  const [copied, setCopied] = useState(false);

  const outputPayload = useMemo<TranscriptSession | TranscriptSession[] | null>(() => {
    if (scope === 'active') {
      return activeSession ? getPureSessionJson(activeSession) : null;
    }
    return allSessions.map(getPureSessionJson);
  }, [scope, activeSession, allSessions]);

  const jsonString = useMemo(
    () => (outputPayload ? JSON.stringify(outputPayload, null, 2) : '[]'),
    [outputPayload]
  );

  const validationIssues = useMemo(() => {
    if (!activeSession) return [];
    const target = activeSession.calibratedResult?.corrected_json ?? activeSession.referenceJson;
    return validateTranscriptSession(target, activeSession.referenceJson);
  }, [activeSession]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(jsonString);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API fallback ignored
    }
  };

  const handleDownload = () => {
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const filename =
      scope === 'active' && activeSession
        ? buildCorrectedJsonFilename(activeSession)
        : `asr_batch_${new Date().toISOString().slice(0, 10)}_修正.json`;
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const errorCount = validationIssues.filter((i) => i.severity === 'error').length;
  const warningCount = validationIssues.filter((i) => i.severity === 'warning').length;

  return (
    <div className="border border-slate-200 bg-white rounded-lg flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
          <button
            type="button"
            onClick={() => setScope('active')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              scope === 'active' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            当前会话原格式
          </button>
          <button
            type="button"
            onClick={() => setScope('batch')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
              scope === 'batch' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            全量数组 ({allSessions.length})
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Copy className="w-3.5 h-3.5" />
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            <span>导出 JSON</span>
          </button>
          {allSessions.length > 0 && (
            <button
              type="button"
              onClick={() => downloadSessionsAsZip(allSessions)}
              title="按原文件独立打包导出为 ZIP"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <FolderArchive className="w-3.5 h-3.5" />
              <span>ZIP 打包</span>
            </button>
          )}
        </div>
      </div>

      {/* Schema & Boundary Check */}
      {activeSession && (
        <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50/70">
          {validationIssues.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-emerald-700 font-medium">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>原格式 Schema 与时间轴边界校验通过（完整无省略）</span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-medium text-amber-800">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
                <span>
                  校验提示：{errorCount} 项错误 · {warningCount} 项注意
                </span>
              </div>
              <ul className="space-y-1 max-h-24 overflow-y-auto">
                {validationIssues.map((issue, idx) => (
                  <li
                    key={idx}
                    onClick={() => issue.utterance_id && onSelectUtterance?.(issue.utterance_id)}
                    className={`text-[11px] leading-snug ${
                      issue.utterance_id ? 'cursor-pointer hover:underline' : ''
                    } ${issue.severity === 'error' ? 'text-rose-700' : 'text-amber-700'}`}
                  >
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Raw JSON Code View */}
      <div className="flex-1 overflow-auto bg-slate-950 text-slate-100 p-4">
        <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
          {jsonString}
        </pre>
      </div>

      {/* Footer Note */}
      <div className="px-4 py-2 border-t border-slate-200 bg-white flex items-center justify-between text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          <span>严格保持原 JSON 结构（无 results/summary 包装），完整保留 transcripts</span>
        </span>
        <span className="font-mono tabular-nums">
          {jsonString.length.toLocaleString()} chars
        </span>
      </div>
    </div>
  );
};
