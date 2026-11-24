import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  FileAudio,
  Loader2,
  Play,
  Plus,
  Scissors,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { Utterance, VocalAudioItem, VocalSegment, VocalSegmentType } from '../types/asr';
import { WaveformPlayer } from './WaveformPlayer';
import { detectAudioSpeechBounds, extractAudioFilesForVocalImport } from '../utils/batchImport';
import { formatSec } from '../utils/diff';

interface VocalSegmentWorkbenchProps {
  items: VocalAudioItem[];
  selectedId: string | null;
  progressMap: Record<string, string>;
  onSelectId: (id: string | null) => void;
  onAddItems: (newItems: VocalAudioItem[]) => void;
  onUpdateItem: (id: string, updater: (prev: VocalAudioItem) => VocalAudioItem) => void;
  onRemoveItem: (id: string) => void;
  onDetectItem: (id: string) => Promise<void>;
}

const VOCAL_TYPES: VocalSegmentType[] = ['正常_人声段', '耳语_人声段', '气声_人声段'];

export function computeVocalRowFields(
  item: VocalAudioItem,
  rangeSeparator: '-' | '~' = '-'
): {
  queryId: string;
  diffDuration: string;
  normalRange: string;
  whisperRange: string;
  breathyRange: string;
} {
  const sorted = [...item.segments].sort((a, b) => a.start - b.start);
  const totalDiff = sorted.reduce((acc, s) => acc + Math.max(0, s.end - s.start), 0);

  const formatTypeCol = (t: VocalSegmentType) =>
    sorted
      .filter((s) => s.type === t)
      .map((s) => `${s.start.toFixed(2)}${rangeSeparator}${s.end.toFixed(2)}`)
      .join('; ');

  return {
    queryId: item.queryId,
    diffDuration: sorted.length > 0 ? totalDiff.toFixed(2) : '0.00',
    normalRange: formatTypeCol('正常_人声段'),
    whisperRange: formatTypeCol('耳语_人声段'),
    breathyRange: formatTypeCol('气声_人声段'),
  };
}

function escapeCsvCell(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

export const VocalSegmentWorkbench: React.FC<VocalSegmentWorkbenchProps> = ({
  items,
  selectedId,
  progressMap,
  onSelectId,
  onAddItems,
  onUpdateItem,
  onRemoveItem,
  onDetectItem,
}) => {
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopSegment, setLoopSegment] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playingWindowEnd, setPlayingWindowEnd] = useState<number | null>(null);

  const [tableFilter, setTableFilter] = useState<'all' | 'unconfirmed' | 'confirmed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [rangeSeparator, setRangeSeparator] = useState<'-' | '~'>('-');
  const [copiedTsv, setCopiedTsv] = useState(false);
  const [aligningSegId, setAligningSegId] = useState<string | null>(null);

  // Manual listening & quick marking state (100% local, no AI needed)
  const [activeMarkType, setActiveMarkType] = useState<VocalSegmentType>('正常_人声段');
  const [pendingMarkStart, setPendingMarkStart] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const activeItem = useMemo(
    () => items.find((it) => it.id === selectedId) ?? items[0] ?? null,
    [items, selectedId]
  );

  // Clear pending start mark and auto-sync detected vocal type when switching audio
  useEffect(() => {
    setPendingMarkStart(null);
    if (activeItem?.detectedTypeFromName) {
      setActiveMarkType(activeItem.detectedTypeFromName);
    }
    setActiveSegmentId(activeItem?.segments[0]?.id ?? null);
  }, [activeItem?.id]);

  // Convert VocalSegment[] to Utterance[] so WaveformPlayer displays colored segment regions
  const waveformUtterances: Utterance[] = useMemo(() => {
    if (!activeItem) return [];
    return activeItem.segments.map((seg, idx) => ({
      utterance_id: idx + 1,
      role: seg.type === '正常_人声段' ? 'user' : 'assistant',
      start: seg.start,
      end: seg.end,
      text: `${seg.type}${seg.spokenCue ? `: ${seg.spokenCue}` : ''}`,
    }));
  }, [activeItem]);

  const activeUtteranceId = useMemo(() => {
    if (!activeItem || !activeSegmentId) return null;
    const idx = activeItem.segments.findIndex((s) => s.id === activeSegmentId);
    return idx >= 0 ? idx + 1 : null;
  }, [activeItem, activeSegmentId]);

  // Stop playback automatically at segment end when auditioning a specific segment (unless looping)
  useEffect(() => {
    if (playingWindowEnd === null || loopSegment || !isPlaying || !audioRef.current) return;
    if (currentTime >= playingWindowEnd) {
      audioRef.current.pause();
      setPlayingWindowEnd(null);
    }
  }, [currentTime, playingWindowEnd, loopSegment, isPlaying]);

  const createSegmentWithBounds = useCallback(
    (startVal: number, endVal: number, typeOverride?: VocalSegmentType) => {
      if (!activeItem) return;
      const s = Number(Math.min(startVal, endVal).toFixed(2));
      const e = Number(Math.max(startVal, endVal).toFixed(2));
      const newSeg: VocalSegment = {
        id: `seg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: typeOverride ?? activeMarkType,
        start: Math.max(0, s),
        end: Math.max(s + 0.05, e),
      };
      onUpdateItem(activeItem.id, (prev) => ({
        ...prev,
        segments: [...prev.segments, newSeg],
      }));
      setActiveSegmentId(newSeg.id);
    },
    [activeItem, activeMarkType, onUpdateItem]
  );

  const handleMarkStartNow = useCallback(() => {
    if (!activeItem) return;
    setPendingMarkStart(Number(currentTime.toFixed(2)));
  }, [activeItem, currentTime]);

  const handleMarkEndNow = useCallback(() => {
    if (!activeItem) return;
    const nowT = Number(currentTime.toFixed(2));
    if (pendingMarkStart !== null) {
      createSegmentWithBounds(pendingMarkStart, nowT, activeMarkType);
      setPendingMarkStart(null);
      return;
    }
    // If no pending start, update active segment's end time if selected
    if (activeSegmentId) {
      onUpdateItem(activeItem.id, (prev) => ({
        ...prev,
        segments: prev.segments.map((s) =>
          s.id === activeSegmentId
            ? { ...s, end: Math.max(Number((s.start + 0.05).toFixed(2)), nowT) }
            : s
        ),
      }));
    }
  }, [activeItem, currentTime, pendingMarkStart, activeMarkType, createSegmentWithBounds, activeSegmentId, onUpdateItem]);

  // Global keyboard shortcuts: Space play/pause, I mark start, O mark end, 1/2/3 switch type
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!activeItem) return;

      if (e.code === 'Space') {
        e.preventDefault();
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) {
          setPlayingWindowEnd(null);
          audio.play().catch(() => {});
        } else {
          audio.pause();
        }
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        handleMarkStartNow();
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        handleMarkEndNow();
      } else if (e.key === '1') {
        setActiveMarkType('正常_人声段');
      } else if (e.key === '2') {
        setActiveMarkType('耳语_人声段');
      } else if (e.key === '3') {
        setActiveMarkType('气声_人声段');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeItem, handleMarkStartNow, handleMarkEndNow]);

  const handleSeek = useCallback((time: number) => {
    setPlayingWindowEnd(null);
    setCurrentTime(time);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  }, []);

  const handleFilesImport = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setIsImporting(true);
    setImportError(null);
    try {
      const extracted = await extractAudioFilesForVocalImport(files);
      if (extracted.length === 0) {
        setImportError('未找到可识别的音频文件（支持 wav、mp3、m4a、flac、ogg、aac 或 zip 压缩包）。');
        return;
      }
      onAddItems(extracted);
      onSelectId(extracted[0].id);
      setActiveSegmentId(extracted[0].segments[0]?.id ?? null);
      setCurrentTime(0);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '导入音频失败');
    } finally {
      setIsImporting(false);
    }
  };

  const handlePlaySegment = (seg: VocalSegment) => {
    setActiveSegmentId(seg.id);
    setPlayingWindowEnd(seg.end);
    setCurrentTime(seg.start);
    if (audioRef.current) {
      audioRef.current.currentTime = seg.start;
      audioRef.current.play().catch(() => {});
    }
  };

  const handleUpdateSegment = (segId: string, patch: Partial<VocalSegment>) => {
    if (!activeItem) return;
    onUpdateItem(activeItem.id, (prev) => ({
      ...prev,
      segments: prev.segments.map((s) => (s.id === segId ? { ...s, ...patch } : s)),
    }));
  };

  const handleAddSegment = (type: VocalSegmentType = '正常_人声段') => {
    if (!activeItem) return;
    const maxDur = activeItem.durationSec > 0 ? activeItem.durationSec : 10;
    const lastSeg = activeItem.segments[activeItem.segments.length - 1];
    const start = lastSeg ? Math.min(maxDur - 0.1, Number((lastSeg.end + 0.1).toFixed(2))) : 0;
    const end = Number(Math.max(start + 0.2, maxDur).toFixed(2));
    const newSeg: VocalSegment = {
      id: `seg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      start: Math.max(0, start),
      end: Math.min(maxDur, end) > start ? Math.min(maxDur, end) : Number((start + 0.5).toFixed(2)),
    };
    onUpdateItem(activeItem.id, (prev) => ({
      ...prev,
      segments: [...prev.segments, newSeg],
    }));
    setActiveSegmentId(newSeg.id);
  };

  const handleRemoveSegment = (segId: string) => {
    if (!activeItem) return;
    onUpdateItem(activeItem.id, (prev) => ({
      ...prev,
      segments: prev.segments.filter((s) => s.id !== segId),
    }));
    if (activeSegmentId === segId) setActiveSegmentId(null);
  };

  const handleAlignWaveformBounds = async (seg: VocalSegment) => {
    if (!activeItem) return;
    setAligningSegId(seg.id);
    try {
      const onlyOne = activeItem.segments.length <= 1;
      const winStart = onlyOne ? 0 : Math.max(0, seg.start - 0.6);
      const winEnd = onlyOne
        ? activeItem.durationSec || undefined
        : activeItem.durationSec > 0
          ? Math.min(activeItem.durationSec, seg.end + 0.6)
          : seg.end + 0.6;
      const bounds = await detectAudioSpeechBounds(
        activeItem.audioUrl,
        activeItem.durationSec,
        winStart,
        winEnd
      );
      if (bounds) {
        onUpdateItem(activeItem.id, (prev) => ({
          ...prev,
          durationSec: prev.durationSec > 0 ? prev.durationSec : bounds.totalDuration,
          segments: prev.segments.map((s) =>
            s.id === seg.id ? { ...s, start: bounds.start, end: bounds.end } : s
          ),
        }));
      }
    } finally {
      setAligningSegId(null);
    }
  };

  const handleConfirmAndNext = () => {
    if (!activeItem) return;
    onUpdateItem(activeItem.id, (prev) => ({ ...prev, confirmed: true }));
    const idx = items.findIndex((i) => i.id === activeItem.id);
    const nextUnconfirmed =
      items.slice(idx + 1).find((i) => !i.confirmed) ??
      items.slice(0, idx).find((i) => !i.confirmed);
    if (nextUnconfirmed) {
      onSelectId(nextUnconfirmed.id);
      setActiveSegmentId(null);
      setCurrentTime(0);
    }
  };

  const filteredTableItems = useMemo(() => {
    return items.filter((it) => {
      if (tableFilter === 'confirmed' && !it.confirmed) return false;
      if (tableFilter === 'unconfirmed' && it.confirmed) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        return (
          it.queryId.toLowerCase().includes(q) ||
          it.audioName.toLowerCase().includes(q) ||
          it.segments.some(
            (s) =>
              s.type.toLowerCase().includes(q) ||
              (s.spokenCue ?? '').toLowerCase().includes(q)
          )
        );
      }
      return true;
    });
  }, [items, tableFilter, searchQuery]);

  const buildDelimitedTable = (delimiter: '\t' | ',') => {
    const header = ['QueryID', '时长（s）', '正常_人声段', '耳语_人声段', '气声_人声段'];
    const rows = items.map((it) => {
      const f = computeVocalRowFields(it, rangeSeparator);
      const cols = [f.queryId, f.diffDuration, f.normalRange, f.whisperRange, f.breathyRange];
      return delimiter === ',' ? cols.map(escapeCsvCell).join(',') : cols.join('\t');
    });
    const headLine = delimiter === ',' ? header.map(escapeCsvCell).join(',') : header.join('\t');
    return [headLine, ...rows].join('\n');
  };

  const handleCopyTsv = async () => {
    const tsv = buildDelimitedTable('\t');
    await navigator.clipboard.writeText(tsv);
    setCopiedTsv(true);
    setTimeout(() => setCopiedTsv(false), 2000);
  };

  const handleDownloadTable = (format: 'csv' | 'tsv') => {
    const content =
      format === 'csv' ? `\uFEFF${buildDelimitedTable(',')}` : `\uFEFF${buildDelimitedTable('\t')}`;
    const blob = new Blob([content], {
      type: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/tab-separated-values;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vocal_segments_${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const confirmedCount = items.filter((i) => i.confirmed).length;

  return (
    <div className="flex-1 flex flex-col lg:flex-row min-h-0">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.aac,.webm,.zip"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            handleFilesImport(e.target.files);
          }
          e.target.value = '';
        }}
      />

      {/* Left Queue Sidebar (272px) */}
      <aside className="w-full lg:w-[272px] shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col">
        <div className="p-4 border-b border-slate-200 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold text-slate-700">
              人声标注队列 ({items.length})
            </h2>
            <button
              type="button"
              disabled={isImporting}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              {isImporting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plus className="w-3.5 h-3.5" />
              )}
              <span>导入音频</span>
            </button>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono tabular-nums">
            <span>已确认 {confirmedCount}</span>
            <span aria-hidden="true">/</span>
            <span>总计 {items.length}</span>
          </div>

          {importError && <p className="text-[11px] text-rose-700 leading-snug">{importError}</p>}
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {items.length === 0 ? (
            <div className="p-5 text-xs text-slate-500 leading-relaxed">
              暂无待确认音频。点击上方「导入音频」批量选择音频文件或 ZIP 包，系统将自动提取 QueryID 并支持 AI 识别与起止时间确认。
            </div>
          ) : (
            items.map((item) => {
              const selected = activeItem?.id === item.id;
              const fields = computeVocalRowFields(item, rangeSeparator);
              const statusLabel =
                item.jobState === 'processing'
                  ? '识别中'
                  : item.jobState === 'error'
                    ? '异常'
                    : item.confirmed
                      ? '已确认'
                      : item.segments.length > 0
                        ? '已标待核'
                        : '待标注';

              return (
                <div
                  key={item.id}
                  onClick={() => {
                    onSelectId(item.id);
                    setActiveSegmentId(item.segments[0]?.id ?? null);
                    setCurrentTime(0);
                    setPlayingWindowEnd(null);
                  }}
                  className={`p-3.5 cursor-pointer transition-colors ${
                    selected ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-mono font-semibold text-slate-900 truncate">
                        {item.queryId}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-500 truncate">
                        {item.audioName}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveItem(item.id);
                      }}
                      title="移除音频"
                      className="p-1 text-slate-400 hover:text-rose-700 rounded cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="mt-2 flex items-center justify-between text-[11px]">
                    <span className="font-mono tabular-nums text-slate-500">
                      {item.durationSec > 0 ? formatSec(item.durationSec) : '未知时长'} · 差值{' '}
                      {fields.diffDuration}s
                    </span>

                    {item.jobState === 'processing' && (
                      <span className="inline-flex items-center gap-1 text-blue-700 font-medium">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>{statusLabel}</span>
                      </span>
                    )}
                    {item.jobState === 'error' && (
                      <span className="inline-flex items-center gap-1 text-rose-700 font-medium">
                        <AlertCircle className="w-3 h-3" />
                        <span>{statusLabel}</span>
                      </span>
                    )}
                    {item.jobState !== 'processing' &&
                      item.jobState !== 'error' &&
                      (item.confirmed ? (
                        <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>{statusLabel}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-slate-500">
                          <Clock className="w-3 h-3" />
                          <span>{statusLabel}</span>
                        </span>
                      ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 min-w-0 p-5 overflow-y-auto space-y-5">
        {items.length === 0 ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingOver(true);
            }}
            onDragLeave={() => setIsDraggingOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingOver(false);
              if (e.dataTransfer.files?.length) {
                handleFilesImport(e.dataTransfer.files);
              }
            }}
            className={`max-w-2xl mx-auto mt-10 bg-white border-2 border-dashed rounded-xl p-10 text-center space-y-5 transition-colors ${
              isDraggingOver ? 'border-blue-500 bg-blue-50/40' : 'border-slate-200'
            }`}
          >
            <div className="w-11 h-11 mx-auto rounded-lg bg-slate-100 flex items-center justify-center text-blue-700">
              <FileAudio className="w-5 h-5" />
            </div>

            <div className="space-y-2">
              <h1 className="text-lg font-semibold text-slate-900 font-display">
                纯人工听音标注 · 人声段起止时间确认与表格导出
              </h1>
              <p className="text-sm text-slate-600 leading-relaxed max-w-lg mx-auto">
                批量导入音频或 ZIP 包，系统会根据文件名或文件夹名称自动识别「正常 / 耳语 / 气声」并预填人声起止区间；你只需配合放大波形自己听音微调起止时间，即可按标准 5 列表格直接复制或导出。
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              <button
                type="button"
                disabled={isImporting}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-blue-700 text-white rounded-md hover:bg-blue-800 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                {isImporting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Upload className="w-3.5 h-3.5" />
                )}
                <span>批量选择音频或 ZIP 包</span>
              </button>
            </div>

            <div className="text-xs text-slate-400 font-mono">
              输出列：QueryID · 时长（s） · 正常_人声段 · 耳语_人声段 · 气声_人声段
            </div>

            {importError && <p className="text-xs text-rose-700">{importError}</p>}
          </div>
        ) : (
          <>
            {/* Active Audio Waveform & Start/End Confirmation */}
            {activeItem && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-500 font-mono tabular-nums">
                      <label className="inline-flex items-center gap-1.5 text-slate-700">
                        <span className="text-[11px] text-slate-400">QueryID</span>
                        <input
                          type="text"
                          value={activeItem.queryId}
                          onChange={(e) =>
                            onUpdateItem(activeItem.id, (prev) => ({
                              ...prev,
                              queryId: e.target.value,
                            }))
                          }
                          className="px-2 py-0.5 text-xs font-mono font-semibold text-slate-900 bg-white border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 w-44"
                        />
                      </label>
                      <span aria-hidden="true">·</span>
                      <span>{activeItem.audioName}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        文件总长{' '}
                        {activeItem.durationSec > 0 ? formatSec(activeItem.durationSec) : '加载中'}
                      </span>
                      {activeItem.detectedTypeFromName && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-blue-700 font-medium">
                            命名识别：{activeItem.detectedTypeFromName}
                          </span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="text-slate-900 font-semibold">
                        人声差值时长 {computeVocalRowFields(activeItem, rangeSeparator).diffDuration} s
                      </span>
                    </div>

                    {activeItem.jobState === 'processing' && progressMap[activeItem.id] ? (
                      <div className="flex items-center gap-2 text-xs text-blue-700 font-medium">
                        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                        <span>{progressMap[activeItem.id]}</span>
                      </div>
                    ) : activeItem.errorMessage ? (
                      <div className="flex items-center gap-2 text-xs text-rose-700">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>{activeItem.errorMessage}</span>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">
                        完全支持纯手动听音确定：听音时按 <span className="font-mono font-semibold text-slate-700">I</span> 记起点、<span className="font-mono font-semibold text-slate-700">O</span> 记终点，或在波形上切换「框选打段」直接拖出区间。
                      </p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={activeItem.jobState === 'processing'}
                      onClick={() => onDetectItem(activeItem.id)}
                      title="可选：让 AI 先听一遍自动预填起止时间，再由你人工修改"
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-white border border-slate-200 text-slate-600 rounded-md hover:bg-slate-50 hover:text-slate-900 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {activeItem.jobState === 'processing' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-700" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5 text-slate-500" />
                      )}
                      <span>
                        {activeItem.jobState === 'processing'
                          ? 'AI 识别中...'
                          : 'AI 预填（可选）'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={handleConfirmAndNext}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-emerald-700 text-white rounded-md hover:bg-emerald-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{activeItem.confirmed ? '已确认 · 跳下一条' : '确认此条并下一条'}</span>
                    </button>
                  </div>
                </div>

                {/* Waveform Scrubbing Player */}
                <WaveformPlayer
                  audioUrl={activeItem.audioUrl}
                  audioSize={activeItem.audioSize}
                  durationSec={activeItem.durationSec || 1}
                  utterances={waveformUtterances}
                  activeUtteranceId={activeUtteranceId}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  loopSegment={loopSegment}
                  playbackRate={playbackRate}
                  onTimeUpdate={setCurrentTime}
                  onPlayStateChange={setIsPlaying}
                  onToggleLoopSegment={() => setLoopSegment((v) => !v)}
                  onPlaybackRateChange={setPlaybackRate}
                  onSeek={handleSeek}
                  onSelectUtterance={(uid) => {
                    const seg = activeItem.segments[uid - 1];
                    if (seg) setActiveSegmentId(seg.id);
                  }}
                  onUpdateUtteranceBounds={(uid, start, end) => {
                    const seg = activeItem.segments[uid - 1];
                    if (seg) {
                      handleUpdateSegment(seg.id, { start, end });
                    }
                  }}
                  onCreateSegmentRange={(s, e) => createSegmentWithBounds(s, e, activeMarkType)}
                  audioRef={audioRef}
                />

                {/* Manual Listen & Mark Bar (Zero-AI fast manual annotation) */}
                <div className="bg-white border border-slate-200 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs font-semibold text-slate-800">听音手动打点</span>
                    <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
                      {VOCAL_TYPES.map((vt, i) => (
                        <button
                          key={vt}
                          type="button"
                          onClick={() => setActiveMarkType(vt)}
                          className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                            activeMarkType === vt
                              ? 'bg-white text-blue-700 font-semibold shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {i + 1}. {vt}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={handleMarkStartNow}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        pendingMarkStart !== null
                          ? 'bg-amber-50 border-amber-300 text-amber-900'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span>
                        {pendingMarkStart !== null
                          ? `已记起点 ${pendingMarkStart.toFixed(2)}s（重记 I）`
                          : '记起点 (I)'}
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={pendingMarkStart === null && !activeSegmentId}
                      onClick={handleMarkEndNow}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-700 text-white rounded-md hover:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <span>
                        {pendingMarkStart !== null
                          ? `记终点并生成「${activeMarkType}」(O)`
                          : '将当前时间设为选中段终点 (O)'}
                      </span>
                    </button>

                    {pendingMarkStart !== null && (
                      <button
                        type="button"
                        onClick={() => setPendingMarkStart(null)}
                        className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        取消起点
                      </button>
                    )}
                  </div>

                  <span className="text-[11px] text-slate-400 font-mono whitespace-nowrap">
                    空格 播放/暂停 · 1/2/3 选类型 · Shift+拖拽 框选波形
                  </span>
                </div>

                {/* Segment Start/End Confirmation Grid */}
                <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 text-xs">
                      <h3 className="font-semibold text-slate-900">
                        人声段起止时间确认 ({activeItem.segments.length} 段)
                      </h3>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-500">
                        播放音频时点击「设起点 / 设终点」可直接取当前播放位置
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {VOCAL_TYPES.map((vt) => (
                        <button
                          key={vt}
                          type="button"
                          onClick={() => handleAddSegment(vt)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50/70 hover:bg-blue-100 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <Plus className="w-3 h-3" />
                          <span>{vt}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {activeItem.segments.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500 space-y-2">
                      <p>当前音频尚未添加人声段，你可以直接自己听音标注：</p>
                      <p>
                        ① 播放音频时按 <span className="font-mono font-semibold text-slate-700">I</span> 记起点、<span className="font-mono font-semibold text-slate-700">O</span> 记终点；② 在波形上切换「框选打段」直接拖拽区间；③ 或点击右上角「+ 正常_人声段 / 耳语_人声段 / 气声_人声段」手动添加。
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-medium text-slate-500">
                            <th className="py-2.5 pl-4 pr-2">试听</th>
                            <th className="py-2.5 px-3">人声段类型</th>
                            <th className="py-2.5 px-3">开始时间 (s)</th>
                            <th className="py-2.5 px-3">截止时间 (s)</th>
                            <th className="py-2.5 px-3 text-right">差值时长 (s)</th>
                            <th className="py-2.5 px-3">波形边界 / 口述提示</th>
                            <th className="py-2.5 pl-2 pr-4 text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-xs">
                          {activeItem.segments.map((seg, idx) => {
                            const segDiff = Math.max(0, seg.end - seg.start);
                            const isSelected = activeSegmentId === seg.id;
                            return (
                              <tr
                                key={seg.id}
                                onClick={() => setActiveSegmentId(seg.id)}
                                className={
                                  isSelected ? 'bg-blue-50/50' : 'bg-white hover:bg-slate-50/70'
                                }
                              >
                                <td className="py-2.5 pl-4 pr-2 whitespace-nowrap">
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handlePlaySegment(seg);
                                      }}
                                      title={`试听第 ${idx + 1} 段 (${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s)`}
                                      className={`w-7 h-7 inline-flex items-center justify-center rounded-md border transition-colors cursor-pointer shrink-0 ${
                                        isSelected && isPlaying
                                          ? 'bg-blue-700 border-blue-700 text-white'
                                          : 'bg-white border-slate-200 text-slate-700 hover:border-blue-400 hover:text-blue-700'
                                      }`}
                                    >
                                      <Play className="w-3.5 h-3.5" />
                                    </button>
                                    <span className="font-mono tabular-nums text-slate-500">
                                      #{idx + 1}
                                    </span>
                                  </div>
                                </td>

                                <td className="py-2.5 px-3 whitespace-nowrap">
                                  <select
                                    value={seg.type}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) =>
                                      handleUpdateSegment(seg.id, {
                                        type: e.target.value as VocalSegmentType,
                                      })
                                    }
                                    className="px-2.5 py-1 text-xs font-medium text-slate-900 bg-white border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/20 cursor-pointer"
                                  >
                                    {VOCAL_TYPES.map((vt) => (
                                      <option key={vt} value={vt}>
                                        {vt}
                                      </option>
                                    ))}
                                  </select>
                                </td>

                                <td className="py-2.5 px-3 whitespace-nowrap">
                                  <div className="flex items-center gap-1.5">
                                    <input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      max={activeItem.durationSec > 0 ? activeItem.durationSec : undefined}
                                      value={seg.start}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => {
                                        const val = Number(e.target.value);
                                        if (Number.isFinite(val)) {
                                          handleUpdateSegment(seg.id, {
                                            start: Math.max(0, Number(val.toFixed(2))),
                                          });
                                        }
                                      }}
                                      className="w-20 px-2 py-1 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                    />
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleUpdateSegment(seg.id, {
                                          start: Number(currentTime.toFixed(2)),
                                        });
                                      }}
                                      title="将当前播放头时间设为开始时间"
                                      className="px-1.5 py-1 text-[11px] text-blue-700 hover:bg-blue-50 rounded cursor-pointer whitespace-nowrap shrink-0"
                                    >
                                      设起点
                                    </button>
                                  </div>
                                </td>

                                <td className="py-2.5 px-3 whitespace-nowrap">
                                  <div className="flex items-center gap-1.5">
                                    <input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      max={activeItem.durationSec > 0 ? activeItem.durationSec : undefined}
                                      value={seg.end}
                                      onClick={(e) => e.stopPropagation()}
                                      onChange={(e) => {
                                        const val = Number(e.target.value);
                                        if (Number.isFinite(val)) {
                                          handleUpdateSegment(seg.id, {
                                            end: Math.max(0, Number(val.toFixed(2))),
                                          });
                                        }
                                      }}
                                      className="w-20 px-2 py-1 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                    />
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleUpdateSegment(seg.id, {
                                          end: Number(currentTime.toFixed(2)),
                                        });
                                      }}
                                      title="将当前播放头时间设为截止时间"
                                      className="px-1.5 py-1 text-[11px] text-blue-700 hover:bg-blue-50 rounded cursor-pointer whitespace-nowrap shrink-0"
                                    >
                                      设终点
                                    </button>
                                  </div>
                                </td>

                                <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold text-slate-900 whitespace-nowrap">
                                  {segDiff.toFixed(2)}
                                </td>

                                <td className="py-2.5 px-3">
                                  <div className="flex items-center gap-2.5">
                                    <button
                                      type="button"
                                      disabled={aligningSegId === seg.id || activeItem.audioSize > 35 * 1024 * 1024}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleAlignWaveformBounds(seg);
                                      }}
                                      title="根据波形能量自动去除首尾空白静音"
                                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40"
                                    >
                                      {aligningSegId === seg.id ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <Scissors className="w-3 h-3" />
                                      )}
                                      <span>去静音边界</span>
                                    </button>
                                    {seg.spokenCue && (
                                      <span className="text-slate-500 truncate max-w-[220px]" title={seg.spokenCue}>
                                        {seg.spokenCue}
                                      </span>
                                    )}
                                  </div>
                                </td>

                                <td className="py-2.5 pl-2 pr-4 text-right whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleRemoveSegment(seg.id);
                                    }}
                                    title="删除该段"
                                    className="p-1.5 text-slate-400 hover:text-rose-700 hover:bg-rose-50 rounded transition-colors cursor-pointer"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Output Summary Table & Export */}
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-xs font-semibold text-slate-900">
                    输出表格预览（{items.length} 条）
                  </h3>

                  <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
                    {(
                      [
                        { id: 'all', label: '全部' },
                        { id: 'unconfirmed', label: '待确认' },
                        { id: 'confirmed', label: '已确认' },
                      ] as const
                    ).map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setTableFilter(f.id)}
                        className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                          tableFilter === f.id
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  <div
                    className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md"
                    title="起止时间连接符格式"
                  >
                    <button
                      type="button"
                      onClick={() => setRangeSeparator('-')}
                      className={`px-2 py-1 text-xs font-mono rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        rangeSeparator === '-'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      0.00-1.00
                    </button>
                    <button
                      type="button"
                      onClick={() => setRangeSeparator('~')}
                      className={`px-2 py-1 text-xs font-mono rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        rangeSeparator === '~'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      0.00~1.00
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="筛选 QueryID..."
                      className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 w-44"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleCopyTsv}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {copiedTsv ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedTsv ? '已复制 TSV' : '复制表格 (可直接贴 Excel)'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadTable('csv')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-700 text-white hover:bg-blue-800 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>导出 CSV</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownloadTable('tsv')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>导出 TSV</span>
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-700">
                      <th className="py-2.5 pl-4 pr-3">QueryID</th>
                      <th className="py-2.5 px-3 text-right">时长（s）</th>
                      <th className="py-2.5 px-3">正常_人声段</th>
                      <th className="py-2.5 px-3">耳语_人声段</th>
                      <th className="py-2.5 px-3">气声_人声段</th>
                      <th className="py-2.5 pl-3 pr-4 text-right font-medium text-slate-500">
                        确认状态
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-xs">
                    {filteredTableItems.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-slate-500">
                          没有符合筛选条件的记录。
                        </td>
                      </tr>
                    ) : (
                      filteredTableItems.map((it) => {
                        const row = computeVocalRowFields(it, rangeSeparator);
                        const isSelected = activeItem?.id === it.id;
                        return (
                          <tr
                            key={it.id}
                            onClick={() => {
                              onSelectId(it.id);
                              setActiveSegmentId(it.segments[0]?.id ?? null);
                              setCurrentTime(0);
                            }}
                            className={`cursor-pointer transition-colors ${
                              isSelected ? 'bg-blue-50/60' : 'bg-white hover:bg-slate-50'
                            }`}
                          >
                            <td className="py-2.5 pl-4 pr-3 font-mono font-semibold text-slate-900 whitespace-nowrap">
                              {row.queryId}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900 whitespace-nowrap">
                              {row.diffDuration}
                            </td>
                            <td className="py-2.5 px-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                              {row.normalRange || <span className="text-slate-300">—</span>}
                            </td>
                            <td className="py-2.5 px-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                              {row.whisperRange || <span className="text-slate-300">—</span>}
                            </td>
                            <td className="py-2.5 px-3 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                              {row.breathyRange || <span className="text-slate-300">—</span>}
                            </td>
                            <td className="py-2.5 pl-3 pr-4 text-right whitespace-nowrap">
                              {it.confirmed ? (
                                <span className="text-emerald-700 font-medium">已确认</span>
                              ) : (
                                <span className="text-slate-400">待确认</span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
};
