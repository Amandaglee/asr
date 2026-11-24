import React, { useState } from 'react';
import {
  Upload,
  X,
  FileAudio,
  FileJson,
  AlertCircle,
  FolderArchive,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { QASessionItem, TranscriptSession } from '../types/asr';
import { parseReferenceJsonInput } from '../utils/validation';
import {
  createQASessionItems,
  ParsedBatchPreview,
  parseFilesOrZipForBatch,
} from '../utils/batchImport';

interface ImportSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddSessions: (items: QASessionItem[]) => void;
}

const DEFAULT_JSON_TEMPLATE = `{
  "session_id": "session_001",
  "duration_sec": 12.5,
  "transcripts": [
    {
      "utterance_id": 1,
      "role": "user",
      "start": 0.2,
      "end": 4.1,
      "text": "请粘贴或上传待质检的参考转写文本"
    }
  ]
}`;

export const ImportSessionModal: React.FC<ImportSessionModalProps> = ({
  isOpen,
  onClose,
  onAddSessions,
}) => {
  const [mode, setMode] = useState<'batch' | 'single'>('batch');

  // Batch / ZIP state
  const [isDragging, setIsDragging] = useState(false);
  const [isParsingZip, setIsParsingZip] = useState(false);
  const [batchPreview, setBatchPreview] = useState<ParsedBatchPreview | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  // Single pair state
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [detectedDuration, setDetectedDuration] = useState<number | null>(null);
  const [jsonFileName, setJsonFileName] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState<string>(DEFAULT_JSON_TEMPLATE);
  const [singleError, setSingleError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleBatchFiles = async (fileList: FileList | File[] | null) => {
    if (!fileList) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setIsParsingZip(true);
    setBatchError(null);
    try {
      const preview = await parseFilesOrZipForBatch(files);
      setBatchPreview(preview);
      if (preview.paired.length === 0 && preview.unmatchedAudio.length === 0 && preview.unmatchedJson.length === 0) {
        setBatchError('所选文件或 ZIP 包中未检测到有效的音频或 JSON 文件。');
      }
    } catch (err) {
      setBatchError(err instanceof Error ? `解包失败：${err.message}` : '无法解析所选文件。');
    } finally {
      setIsParsingZip(false);
    }
  };

  const handleConfirmBatch = () => {
    if (!batchPreview || batchPreview.paired.length === 0) return;
    const items = createQASessionItems(batchPreview.paired);
    onAddSessions(items);
    setBatchPreview(null);
    setBatchError(null);
    onClose();
  };

  const handleAudioPick = (file: File | null) => {
    if (!file) return;
    setAudioFile(file);
    setSingleError(null);

    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio(objectUrl);
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        const rounded = Number(audio.duration.toFixed(2));
        setDetectedDuration(rounded);
        try {
          const parsed = JSON.parse(jsonText);
          if (parsed && typeof parsed === 'object' && parsed.session_id === 'session_001') {
            parsed.duration_sec = rounded;
            parsed.session_id = file.name.replace(/\.[^.]+$/, '');
            setJsonText(JSON.stringify(parsed, null, 2));
          }
        } catch {
          // Ignore if user is mid-edit
        }
      }
      URL.revokeObjectURL(objectUrl);
    });
  };

  const handleJsonPick = async (file: File | null) => {
    if (!file) return;
    try {
      const content = await file.text();
      setJsonFileName(file.name);
      setJsonText(content);
      setSingleError(null);
    } catch {
      setSingleError('无法读取所选 JSON 文件。');
    }
  };

  const handleSingleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!audioFile) {
      setSingleError('请先选择待核对的原始音频文件。');
      return;
    }

    const { session, error } = parseReferenceJsonInput(jsonText);
    if (error || !session) {
      setSingleError(error || '参考 JSON 格式无效。');
      return;
    }

    const finalSession: TranscriptSession = {
      ...session,
      duration_sec: session.duration_sec > 0 ? session.duration_sec : detectedDuration || 10,
    };

    const audioUrl = URL.createObjectURL(audioFile);
    onAddSessions([
      {
        id: `${finalSession.session_id}-${Date.now()}`,
        audioName: audioFile.name,
        sourceJsonName: jsonFileName || undefined,
        audioMimeType: audioFile.type || 'audio/wav',
        audioSize: audioFile.size,
        audioUrl,
        audioFile,
        referenceJson: finalSession,
        jobState: 'pending',
        lastUpdatedAt: Date.now(),
      },
    ]);

    setAudioFile(null);
    setDetectedDuration(null);
    setJsonFileName(null);
    setJsonText(DEFAULT_JSON_TEMPLATE);
    setSingleError(null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl shadow-lg overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-4">
            <h2 className="text-base font-semibold text-slate-900 font-display">
              导入质检样本
            </h2>
            <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
              <button
                type="button"
                onClick={() => setMode('batch')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  mode === 'batch' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                ZIP / 多文件批量导入
              </button>
              <button
                type="button"
                onClick={() => setMode('single')}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  mode === 'single' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                单条导入（粘贴 JSON）
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Batch ZIP / Multi-file Mode */}
        {mode === 'batch' ? (
          <div className="p-6 space-y-4 overflow-y-auto">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                handleBatchFiles(e.dataTransfer.files);
              }}
              className={`flex flex-col items-center justify-center px-6 py-8 border-2 border-dashed rounded-lg transition-colors cursor-pointer text-center ${
                isDragging
                  ? 'border-blue-600 bg-blue-50/70'
                  : 'border-slate-300 bg-slate-50 hover:bg-slate-100/70'
              }`}
            >
              {isParsingZip ? (
                <Loader2 className="w-7 h-7 text-blue-700 animate-spin mb-2" />
              ) : (
                <FolderArchive className="w-7 h-7 text-blue-700 mb-2" />
              )}
              <p className="text-sm font-medium text-slate-900">
                {isParsingZip
                  ? '正在解包并自动配对音频与 JSON...'
                  : '拖拽或点击选择 .zip 压缩包，或同时多选音频与 .json 文件'}
              </p>
              <p className="mt-1.5 text-xs text-slate-500 max-w-md leading-relaxed">
                自动按「同名文件（如 s01.wav + s01.json）」、「JSON 内 session_id」或「audio_file 字段」配对；100MB+ 大音频建议直接全选音频与 JSON 拖入（无需打包，自动分片上传）。
              </p>
              <input
                type="file"
                multiple
                accept=".zip,application/zip,audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm,.aac,.json,application/json"
                className="hidden"
                onChange={(e) => handleBatchFiles(e.target.files)}
              />
            </label>

            {batchError && (
              <div className="flex items-start gap-2 px-3.5 py-2.5 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                <span>{batchError}</span>
              </div>
            )}

            {batchPreview && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-800 inline-flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>
                      成功配对 {batchPreview.paired.length} 组样本
                    </span>
                  </span>
                  {(batchPreview.unmatchedAudio.length > 0 ||
                    batchPreview.unmatchedJson.length > 0) && (
                    <span className="text-amber-700 font-medium">
                      未配对：{batchPreview.unmatchedAudio.length} 音频 ·{' '}
                      {batchPreview.unmatchedJson.length} JSON
                    </span>
                  )}
                </div>

                {batchPreview.paired.length > 0 && (
                  <div className="border border-slate-200 rounded-lg overflow-hidden max-h-52 overflow-y-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                          <th className="py-2 px-3">Session ID</th>
                          <th className="py-2 px-3">音频文件</th>
                          <th className="py-2 px-3 text-right">语句数</th>
                          <th className="py-2 px-3 text-right">配对方式</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {batchPreview.paired.map((p, i) => (
                          <tr key={i} className="bg-white">
                            <td className="py-2 px-3 font-mono font-medium text-slate-900">
                              {p.session.session_id}
                            </td>
                            <td className="py-2 px-3 text-slate-600 truncate max-w-[180px]">
                              {p.audioFile.name}
                            </td>
                            <td className="py-2 px-3 text-right font-mono tabular-nums text-slate-700">
                              {p.session.transcripts.length}
                            </td>
                            <td className="py-2 px-3 text-right text-emerald-700">
                              {p.matchReason}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {(batchPreview.unmatchedAudio.length > 0 ||
                  batchPreview.unmatchedJson.length > 0) && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 space-y-1 max-h-28 overflow-y-auto">
                    {batchPreview.unmatchedAudio.map((name, idx) => (
                      <div key={`ua-${idx}`}>未匹配音频：{name}（缺少对应的参考 JSON）</div>
                    ))}
                    {batchPreview.unmatchedJson.map((j, idx) => (
                      <div key={`uj-${idx}`}>
                        未匹配 JSON：{j.fileName}（{j.reason}）
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-200">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-md cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                disabled={!batchPreview || batchPreview.paired.length === 0}
                onClick={handleConfirmBatch}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-blue-700 text-white rounded-md hover:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>
                  批量加入队列 ({batchPreview?.paired.length ?? 0} 组)
                </span>
              </button>
            </div>
          </div>
        ) : (
          /* Single Audio + JSON Mode */
          <form onSubmit={handleSingleSubmit} className="p-6 space-y-5 overflow-y-auto">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-2">
                1. 原始音频文件（WAV / MP3 / M4A / OGG / FLAC / WEBM）
              </label>
              <label className="flex items-center justify-between px-4 py-3 border border-dashed border-slate-300 rounded-lg bg-slate-50 hover:bg-slate-100/70 transition-colors cursor-pointer">
                <div className="flex items-center gap-3 min-w-0">
                  <FileAudio className="w-5 h-5 text-blue-700 shrink-0" />
                  {audioFile ? (
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{audioFile.name}</p>
                      <p className="text-xs text-slate-500 font-mono tabular-nums">
                        {(audioFile.size / 1024).toFixed(1)} KB
                        {detectedDuration ? ` · 检测时长 ${detectedDuration}s` : ''}
                      </p>
                    </div>
                  ) : (
                    <span className="text-sm text-slate-600">点击选择音频文件</span>
                  )}
                </div>
                <span className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-200 rounded-md text-slate-700 shrink-0">
                  浏览文件
                </span>
                <input
                  type="file"
                  accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm,.aac"
                  className="hidden"
                  onChange={(e) => handleAudioPick(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-slate-700">
                  2. 参考转写 JSON（支持直接粘贴或上传 .json 文件）
                </label>
                <label className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:text-blue-800 cursor-pointer">
                  <FileJson className="w-3.5 h-3.5" />
                  <span>导入 .json 文件</span>
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => handleJsonPick(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
              <textarea
                rows={8}
                value={jsonText}
                onChange={(e) => {
                  setJsonText(e.target.value);
                  setSingleError(null);
                }}
                spellCheck={false}
                className="w-full px-3.5 py-2.5 text-xs font-mono leading-relaxed text-slate-900 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500"
              />
            </div>

            {singleError && (
              <div className="flex items-start gap-2 px-3.5 py-2.5 text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded-lg">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                <span>{singleError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-md cursor-pointer"
              >
                取消
              </button>
              <button
                type="submit"
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-blue-700 text-white rounded-md hover:bg-blue-800 transition-colors cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>加入质检队列</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
