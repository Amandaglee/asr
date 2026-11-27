import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  FileAudio,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  CalibrationBatchOutput,
  CalibrationResultItem,
  QASessionItem,
  Utterance,
  VocalAudioItem,
  VocalSegmentType,
} from './types/asr';
import { WaveformPlayer } from './components/WaveformPlayer';
import { UtteranceRow } from './components/UtteranceRow';
import { ImportSessionModal } from './components/ImportSessionModal';
import { JsonInspectorPanel } from './components/JsonInspectorPanel';
import { RulesAndGlossaryView } from './components/RulesAndGlossaryView';
import { BatchSummaryView } from './components/BatchSummaryView';
import {
  computeVocalRowFields,
  VocalSegmentWorkbench,
} from './components/VocalSegmentWorkbench';
import { formatSec } from './utils/diff';
import {
  areUtteranceExtraFieldsEqual,
  extractAllRoles,
  extractExtraUtteranceColumns,
} from './utils/validation';

type ActiveTab = 'workbench' | 'vocal' | 'batch' | 'rules' | 'export';

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

async function parseApiResponse<T>(res: Response): Promise<T> {
  const raw = await res.text();
  const trimmed = raw.trim();
  if (trimmed.startsWith('<')) {
    if (res.status === 413) {
      throw new Error('单个音频文件超过网关 32MB 请求上限，请先压缩或分段后再上传。');
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error(`服务端暂未就绪或处理超时 (HTTP ${res.status})，请稍等几秒后重试。`);
    }
    throw new Error(`接口返回了网页而非 JSON (HTTP ${res.status})，请刷新页面或检查服务端状态。`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`服务端响应格式异常 (HTTP ${res.status})：${trimmed.slice(0, 120)}`);
  }
}

type PersistableQASession = Omit<QASessionItem, 'audioFile' | 'audioUrl' | 'audioBase64'>;
type PersistableVocalItem = Omit<VocalAudioItem, 'audioFile' | 'audioUrl'>;

type StoredHistoryRecord =
  | {
      id: string;
      kind: 'qa';
      audioUrl: string;
      data: PersistableQASession;
    }
  | {
      id: string;
      kind: 'vocal';
      audioUrl: string;
      data: PersistableVocalItem;
    };

function getQASessionData(item: QASessionItem): PersistableQASession {
  const { audioFile: _audioFile, audioUrl: _audioUrl, audioBase64: _audioBase64, ...data } = item;
  return data;
}

function getVocalItemData(item: VocalAudioItem): PersistableVocalItem {
  const { audioFile: _audioFile, audioUrl: _audioUrl, ...data } = item;
  return data;
}

async function uploadHistoryRecord(
  kind: 'qa' | 'vocal',
  data: PersistableQASession | PersistableVocalItem,
  file: File
): Promise<{ id: string; audioUrl: string }> {
  const initRes = await fetch('/api/upload-init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      totalChunks: Math.max(1, Math.ceil(file.size / (8 * 1024 * 1024))),
    }),
  });
  const initData = await parseApiResponse<{ uploadId?: string; error?: string }>(initRes);
  if (!initRes.ok || !initData.uploadId) {
    throw new Error(initData.error || '初始化本地作业保存失败');
  }

  const uploadId = initData.uploadId;
  try {
    const chunkSize = 8 * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
    let nextChunkIndex = 0;
    const uploadWorker = async () => {
      while (true) {
        const index = nextChunkIndex++;
        if (index >= totalChunks) return;
        const start = index * chunkSize;
        const chunk = file.slice(start, Math.min(file.size, start + chunkSize));
        const formData = new FormData();
        formData.append('uploadId', uploadId);
        formData.append('chunkIndex', String(index));
        formData.append('chunk', chunk, `${file.name}.part${index}`);
        const chunkRes = await fetch('/api/upload-chunk', { method: 'POST', body: formData });
        const chunkData = await parseApiResponse<{ error?: string }>(chunkRes);
        if (!chunkRes.ok) {
          throw new Error(chunkData.error || `保存音频分片 ${index + 1} 失败`);
        }
      }
    };
    const workers = Math.min(4, totalChunks);
    await Promise.all(Array.from({ length: workers }, () => uploadWorker()));

    const saveRes = await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, kind, data }),
    });
    const saved = await parseApiResponse<{ id?: string; audioUrl?: string; error?: string }>(saveRes);
    if (!saveRes.ok || !saved.id || !saved.audioUrl) {
      throw new Error(saved.error || '保存本地作业记录失败');
    }
    return { id: saved.id, audioUrl: saved.audioUrl };
  } catch (error) {
    const cleanupRes = await fetch(`/api/upload/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
    });
    if (!cleanupRes.ok && cleanupRes.status !== 404) {
      const cleanup = await parseApiResponse<{ error?: string }>(cleanupRes);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}；清理未完成上传失败：${cleanup.error || cleanupRes.status}`
      );
    }
    throw error;
  }
}

async function loadStoredAudio(audioUrl: string, fileName: string, mimeType: string): Promise<File> {
  const response = await fetch(audioUrl);
  if (!response.ok) {
    const data = await parseApiResponse<{ error?: string }>(response);
    throw new Error(data.error || '无法读取本地保存的音频文件。');
  }
  return new File([await response.blob()], fileName, { type: mimeType });
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('workbench');
  const [sessions, setSessions] = useState<QASessionItem[]>([]);
  const [historyStoragePath, setHistoryStoragePath] = useState('');
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyReady, setHistoryReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [isGeneratingDemo, setIsGeneratingDemo] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [customRules, setCustomRules] = useState<string>('');
  const [timestampMode, setTimestampMode] = useState<'lock' | 'conservative'>('lock');
  const [progressMap, setProgressMap] = useState<Record<string, string>>({});

  // Vocal segment confirmation state
  const [vocalItems, setVocalItems] = useState<VocalAudioItem[]>([]);
  const [selectedVocalId, setSelectedVocalId] = useState<string | null>(null);
  const [vocalProgressMap, setVocalProgressMap] = useState<Record<string, string>>({});

  // Workbench filters & audio playback state
  const [filterMode, setFilterMode] = useState<'all' | 'changed'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeUtteranceId, setActiveUtteranceId] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopSegment, setLoopSegment] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [customRoles, setCustomRoles] = useState<string[]>([]);
  const [autoEditUtteranceId, setAutoEditUtteranceId] = useState<number | null>(null);
  const [lastDeletedEntry, setLastDeletedEntry] = useState<{
    sessionId: string;
    index: number;
    utterance: Utterance;
    origRefId?: number;
  } | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const quickEditRef = useRef<HTMLTextAreaElement | null>(null);
  const skipInitialHistorySync = useRef(true);
  const historySnapshots = useRef(new Map<string, string>());

  useEffect(() => {
    let active = true;
    const loadHistory = async () => {
      try {
        const response = await fetch('/api/history');
        const payload = await parseApiResponse<{
          storagePath: string;
          records: StoredHistoryRecord[];
          error?: string;
        }>(response);
        if (!response.ok) {
          throw new Error(payload.error || '读取本地作业历史失败。');
        }
        if (!active) return;

        const qaRecords = payload.records
          .filter((record): record is Extract<StoredHistoryRecord, { kind: 'qa' }> => record.kind === 'qa')
          .map(({ id, audioUrl, data }) => {
            const interrupted = data.jobState === 'processing';
            return {
              ...data,
              id,
              audioUrl,
              jobState: interrupted ? 'error' as const : data.jobState,
              errorMessage: interrupted ? '应用上次关闭时任务仍在运行，请重新运行。' : data.errorMessage,
            };
          });
        const vocalRecords = payload.records
          .filter((record): record is Extract<StoredHistoryRecord, { kind: 'vocal' }> => record.kind === 'vocal')
          .map(({ id, audioUrl, data }) => {
            const interrupted = data.jobState === 'processing';
            return {
              ...data,
              id,
              audioUrl,
              jobState: interrupted ? 'error' as const : data.jobState,
              errorMessage: interrupted ? '应用上次关闭时任务仍在运行，请重新运行。' : data.errorMessage,
            };
          });
        setSessions((current) => [...qaRecords, ...current.filter((item) => !qaRecords.some((saved) => saved.id === item.id))]);
        setVocalItems((current) => [...vocalRecords, ...current.filter((item) => !vocalRecords.some((saved) => saved.id === item.id))]);
        setHistoryStoragePath(payload.storagePath);
      } catch (error) {
        if (active) {
          setHistoryError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (active) setHistoryReady(true);
      }
    };
    void loadHistory();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!historyReady) return;
    if (skipInitialHistorySync.current) {
      for (const item of sessions) {
        historySnapshots.current.set(item.id, JSON.stringify(getQASessionData(item)));
      }
      for (const item of vocalItems) {
        historySnapshots.current.set(item.id, JSON.stringify(getVocalItemData(item)));
      }
      skipInitialHistorySync.current = false;
      return;
    }
    const timeout = window.setTimeout(() => {
      const persist = async () => {
        const records = [
          ...sessions.map((item) => ({
            id: item.id,
            data: getQASessionData(item),
          })),
          ...vocalItems.map((item) => ({
            id: item.id,
            data: getVocalItemData(item),
          })),
        ];
        for (const record of records) {
          const serialized = JSON.stringify(record.data);
          if (historySnapshots.current.get(record.id) === serialized) continue;
          const response = await fetch(`/api/history/${encodeURIComponent(record.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: record.data }),
          });
          const result = await parseApiResponse<{ error?: string }>(response);
          if (!response.ok) {
            throw new Error(result.error || '更新本地作业记录失败。');
          }
          historySnapshots.current.set(record.id, serialized);
        }
        setHistoryError(null);
      };
      void persist().catch((error: unknown) => {
        setHistoryError(error instanceof Error ? error.message : String(error));
      });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [historyReady, sessions, vocalItems]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null,
    [sessions, selectedId]
  );
  const activeTranscripts =
    activeSession?.calibratedResult?.corrected_json.transcripts ??
    activeSession?.referenceJson.transcripts;
  const selectedUtterance = activeTranscripts?.find((u) => u.utterance_id === activeUtteranceId);

  // Sync activeUtteranceId when audio plays
  useEffect(() => {
    if (!isPlaying || document.activeElement === quickEditRef.current) return;
    // Keep the selected block at shared boundaries and within overlapping segments.
    if (selectedUtterance && currentTime >= selectedUtterance.start && currentTime <= selectedUtterance.end) return;
    const hit = activeTranscripts?.find((u) => currentTime >= u.start && currentTime < u.end);
    if (hit) {
      setActiveUtteranceId(hit.utterance_id);
    }
  }, [currentTime, activeTranscripts, isPlaying, selectedUtterance]);

  // Global Space shortcut for audio play/pause when not typing in inputs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (activeTab !== 'workbench' || !activeSession) return;
      e.preventDefault();
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) {
        audio.play().catch(() => {});
      } else {
        audio.pause();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeTab, activeSession]);

  const handleSeek = useCallback((time: number) => {
    setCurrentTime(time);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  }, []);

  const handlePlaySegment = useCallback(
    (u: Utterance) => {
      setActiveUtteranceId(u.utterance_id);
      if (audioRef.current) {
        audioRef.current.currentTime = u.start;
        audioRef.current.play().catch(() => {});
      }
      setCurrentTime(u.start);
    },
    []
  );

  const handleAddSessions = async (items: QASessionItem[]) => {
    if (items.length === 0) return;
    const savedItems: QASessionItem[] = [];
    for (const item of items) {
      try {
        if (!item.audioFile) throw new Error(`样本 ${item.audioName} 缺少音频文件。`);
        const saved = await uploadHistoryRecord('qa', getQASessionData(item), item.audioFile);
        savedItems.push({ ...item, id: saved.id, audioUrl: saved.audioUrl });
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : '保存本地作业失败。');
      }
    }
    if (savedItems.length === 0) return;
    setSessions((prev) => [...prev, ...savedItems]);
    setSelectedId(savedItems[0].id);
    setActiveUtteranceId(null);
    setCurrentTime(0);
    setActiveTab('workbench');
  };

  const handleAddVocalItems = async (items: VocalAudioItem[]) => {
    const savedItems: VocalAudioItem[] = [];
    for (const item of items) {
      try {
        if (!item.audioFile) throw new Error(`样本 ${item.audioName} 缺少音频文件。`);
        const saved = await uploadHistoryRecord('vocal', getVocalItemData(item), item.audioFile);
        savedItems.push({ ...item, id: saved.id, audioUrl: saved.audioUrl });
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : '保存本地作业失败。');
      }
    }
    if (savedItems.length === 0) return;
    setVocalItems((prev) => [...prev, ...savedItems]);
    if (!selectedVocalId) setSelectedVocalId(savedItems[0].id);
  };

  const handleRemoveSession = (id: string) => {
    setSessions((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target?.audioUrl) {
        URL.revokeObjectURL(target.audioUrl);
      }
      const next = prev.filter((s) => s.id !== id);
      if (selectedId === id) {
        setSelectedId(next[0]?.id ?? null);
      }
      return next;
    });
  };

  const handleGenerateDemoSample = async () => {
    setIsGeneratingDemo(true);
    setDemoError(null);
    try {
      const res = await fetch('/api/demo-sample', { method: 'POST' });
      const data = await parseApiResponse<{
        audioBase64: string;
        mimeType?: string;
        fileName?: string;
        referenceJson: QASessionItem['referenceJson'];
        error?: string;
      }>(res);
      if (!res.ok) {
        throw new Error(data.error || '示例语音生成失败');
      }

      const blob = base64ToBlob(data.audioBase64, data.mimeType || 'audio/wav');
      const file = new File([blob], data.fileName || 'demo_home_safety_01.wav', {
        type: data.mimeType || 'audio/wav',
      });
      const audioUrl = URL.createObjectURL(blob);

      const newSession: QASessionItem = {
        id: `${data.referenceJson.session_id}-${Date.now()}`,
        audioName: file.name,
        audioMimeType: file.type,
        audioSize: file.size,
        audioUrl,
        audioFile: file,
        referenceJson: data.referenceJson,
        jobState: 'pending',
        lastUpdatedAt: Date.now(),
      };

      const saved = await uploadHistoryRecord('qa', getQASessionData(newSession), file);
      const persistedSession = { ...newSession, id: saved.id, audioUrl: saved.audioUrl };
      setSessions((prev) => [...prev, persistedSession]);
      setSelectedId(persistedSession.id);
      setActiveUtteranceId(null);
      setCurrentTime(0);
      setActiveTab('workbench');
    } catch (err) {
      setDemoError(err instanceof Error ? err.message : '无法加载示例音频');
    } finally {
      setIsGeneratingDemo(false);
    }
  };

  const setSessionProgress = (sessionId: string, text: string) => {
    setProgressMap((prev) => ({ ...prev, [sessionId]: text }));
  };

  const runCalibrationForSession = async (sessionId: string) => {
    const target = sessions.find((s) => s.id === sessionId);
    if (!target) return;
    const rulesUsed = customRules.trim();
    const timestampModeUsed = timestampMode;

    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId
          ? {
              ...s,
              jobState: 'processing',
              errorMessage: undefined,
              appliedCustomRules: rulesUsed,
              appliedTimestampMode: timestampModeUsed,
              lastUpdatedAt: Date.now(),
            }
          : s
      )
    );

    try {
      const file =
        target.audioFile ??
        (await loadStoredAudio(target.audioUrl, target.audioName, target.audioMimeType));
      const workingJson = target.calibratedResult?.corrected_json ?? target.referenceJson;
      const refStr = JSON.stringify(workingJson);
      let data: CalibrationBatchOutput & { error?: string };

      // Files > 6MB use 8MB chunked upload + async job polling to bypass gateway 32MB body limit & 300s timeout
      if (file.size > 6 * 1024 * 1024) {
        const CHUNK_SIZE = 8 * 1024 * 1024;
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        setSessionProgress(sessionId, `准备分片上传 (${totalChunks} 片)...`);
        const initRes = await fetch('/api/upload-init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type || 'audio/wav',
            totalChunks,
          }),
        });
        const initData = await parseApiResponse<{ uploadId: string; error?: string }>(initRes);
        if (!initRes.ok || !initData.uploadId) {
          throw new Error(initData.error || '分片上传初始化失败');
        }

        // Upload up to 4 chunks in parallel for faster 100MB+ transfers
        let completedChunks = 0;
        let nextChunkIdx = 0;
        const CHUNK_CONCURRENCY = Math.min(4, totalChunks);

        const uploadWorker = async () => {
          while (true) {
            const idx = nextChunkIdx++;
            if (idx >= totalChunks) break;

            const start = idx * CHUNK_SIZE;
            const end = Math.min(file.size, start + CHUNK_SIZE);
            const chunkBlob = file.slice(start, end);

            const chunkForm = new FormData();
            chunkForm.append('uploadId', initData.uploadId);
            chunkForm.append('chunkIndex', String(idx));
            chunkForm.append('chunk', chunkBlob, `${file.name}.part${idx}`);

            const chunkRes = await fetch('/api/upload-chunk', {
              method: 'POST',
              body: chunkForm,
            });
            const chunkData = await parseApiResponse<{ ok?: boolean; error?: string }>(chunkRes);
            if (!chunkRes.ok) {
              throw new Error(chunkData.error || `分片 ${idx + 1} 上传失败`);
            }

            completedChunks++;
            const pct = Math.round((completedChunks / totalChunks) * 100);
            setSessionProgress(sessionId, `分片并发上传中 ${pct}% (${completedChunks}/${totalChunks})`);
          }
        };

        await Promise.all(Array.from({ length: CHUNK_CONCURRENCY }, () => uploadWorker()));

        setSessionProgress(sessionId, '已上传完毕，提交 AI 核对任务...');
        const startRes = await fetch('/api/calibrate-start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uploadId: initData.uploadId,
            referenceJson: refStr,
            customRules: rulesUsed,
            timestampMode: timestampModeUsed,
          }),
        });
        const startData = await parseApiResponse<{ jobId: string; error?: string }>(startRes);
        if (!startRes.ok || !startData.jobId) {
          throw new Error(startData.error || '启动异步校准任务失败');
        }

        // Poll job status every 2s until complete or error
        while (true) {
          await new Promise((r) => setTimeout(r, 2000));
          const pollRes = await fetch(`/api/jobs/${encodeURIComponent(startData.jobId)}`);
          const jobData = await parseApiResponse<{
            status: string;
            progressText: string;
            result?: CalibrationBatchOutput;
            error?: string;
          }>(pollRes);

          if (!pollRes.ok) {
            throw new Error(jobData.error || '查询校准任务状态失败');
          }
          setSessionProgress(sessionId, jobData.progressText || '处理中...');

          if (jobData.status === 'completed' && jobData.result) {
            data = jobData.result;
            break;
          }
          if (jobData.status === 'error') {
            throw new Error(jobData.error || '大音频校准处理失败');
          }
        }
      } else {
        setSessionProgress(sessionId, 'AI 正在逐帧核对中...');
        const formData = new FormData();
        formData.append('audio', file);
        formData.append('referenceJson', refStr);
        formData.append('timestampMode', timestampModeUsed);
        if (rulesUsed) {
          formData.append('customRules', rulesUsed);
        }

        const res = await fetch('/api/calibrate', {
          method: 'POST',
          body: formData,
        });
        data = await parseApiResponse<CalibrationBatchOutput & { error?: string }>(res);
        if (!res.ok) {
          throw new Error(data.error || '音频校准服务返回异常');
        }
      }

      if (!data.results || data.results.length === 0) {
        throw new Error(data.error || '音频校准服务返回异常');
      }

      const resultItem: CalibrationResultItem = data.results[0];

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                jobState: 'completed',
                calibratedResult: resultItem,
                refAnchorMap: undefined,
                errorMessage: undefined,
                lastUpdatedAt: Date.now(),
              }
            : s
        )
      );
      setSessionProgress(sessionId, '');
    } catch (err) {
      const message = err instanceof Error ? err.message : '校准请求失败';
      setSessionProgress(sessionId, '');
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, jobState: 'error', errorMessage: message, lastUpdatedAt: Date.now() }
            : s
        )
      );
    }
  };

  const handleRunBatch = async () => {
    const pendingOrError = sessions.filter(
      (s) => s.jobState === 'pending' || s.jobState === 'error'
    );
    const targets = pendingOrError.length > 0 ? pendingOrError : sessions;
    const BATCH_CONCURRENCY = Math.min(3, targets.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const item = targets[cursor++];
        if (!item) break;
        await runCalibrationForSession(item.id);
      }
    };

    await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, () => worker()));
  };

  const setVocalProgress = (id: string, text: string) => {
    setVocalProgressMap((prev) => ({ ...prev, [id]: text }));
  };

  const runVocalDetectionForItem = async (itemId: string) => {
    const target = vocalItems.find((v) => v.id === itemId);
    if (!target) return;

    setVocalItems((prev) =>
      prev.map((v) =>
        v.id === itemId ? { ...v, jobState: 'processing', errorMessage: undefined } : v
      )
    );

    try {
      const file =
        target.audioFile ??
        (await loadStoredAudio(target.audioUrl, target.audioName, target.audioMimeType));
      let detected: {
        segments: Array<{
          type: VocalSegmentType;
          start: number;
          end: number;
          spokenCue?: string;
        }>;
        error?: string;
      };

      if (file.size > 6 * 1024 * 1024) {
        const CHUNK_SIZE = 8 * 1024 * 1024;
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        setVocalProgress(itemId, `准备分片上传 (${totalChunks} 片)...`);
        const initRes = await fetch('/api/upload-init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type || 'audio/wav',
            totalChunks,
          }),
        });
        const initData = await parseApiResponse<{ uploadId: string; error?: string }>(initRes);
        if (!initRes.ok || !initData.uploadId) {
          throw new Error(initData.error || '分片上传初始化失败');
        }

        let completedChunks = 0;
        let nextChunkIdx = 0;
        const CHUNK_CONCURRENCY = Math.min(4, totalChunks);

        const uploadWorker = async () => {
          while (true) {
            const idx = nextChunkIdx++;
            if (idx >= totalChunks) break;

            const start = idx * CHUNK_SIZE;
            const end = Math.min(file.size, start + CHUNK_SIZE);
            const chunkForm = new FormData();
            chunkForm.append('uploadId', initData.uploadId);
            chunkForm.append('chunkIndex', String(idx));
            chunkForm.append('chunk', file.slice(start, end), `${file.name}.part${idx}`);

            const chunkRes = await fetch('/api/upload-chunk', {
              method: 'POST',
              body: chunkForm,
            });
            const chunkData = await parseApiResponse<{ ok?: boolean; error?: string }>(chunkRes);
            if (!chunkRes.ok) {
              throw new Error(chunkData.error || `分片 ${idx + 1} 上传失败`);
            }
            completedChunks++;
            const pct = Math.round((completedChunks / totalChunks) * 100);
            setVocalProgress(itemId, `分片上传中 ${pct}% (${completedChunks}/${totalChunks})`);
          }
        };

        await Promise.all(Array.from({ length: CHUNK_CONCURRENCY }, () => uploadWorker()));

        setVocalProgress(itemId, '已上传完毕，AI 正在定位人声段...');
        const startRes = await fetch('/api/vocal-detect-start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uploadId: initData.uploadId,
            durationSec: target.durationSec || undefined,
          }),
        });
        const startData = await parseApiResponse<{ jobId: string; error?: string }>(startRes);
        if (!startRes.ok || !startData.jobId) {
          throw new Error(startData.error || '启动人声识别任务失败');
        }

        while (true) {
          await new Promise((r) => setTimeout(r, 2000));
          const pollRes = await fetch(`/api/jobs/${encodeURIComponent(startData.jobId)}`);
          const jobData = await parseApiResponse<{
            status: string;
            progressText: string;
            result?: typeof detected;
            error?: string;
          }>(pollRes);
          if (!pollRes.ok) {
            throw new Error(jobData.error || '查询识别进度失败');
          }
          setVocalProgress(itemId, jobData.progressText || '识别中...');
          if (jobData.status === 'completed' && jobData.result) {
            detected = jobData.result;
            break;
          }
          if (jobData.status === 'error') {
            throw new Error(jobData.error || '人声段识别失败');
          }
        }
      } else {
        setVocalProgress(itemId, 'AI 正在识别人声类型与起止时间...');
        const formData = new FormData();
        formData.append('audio', file);
        if (target.durationSec > 0) {
          formData.append('durationSec', String(target.durationSec));
        }
        const res = await fetch('/api/vocal-detect', {
          method: 'POST',
          body: formData,
        });
        detected = await parseApiResponse<typeof detected>(res);
        if (!res.ok) {
          throw new Error(detected.error || '人声识别服务异常');
        }
      }

      const mappedSegments = (detected.segments ?? []).map((seg, idx) => ({
        id: `seg-${itemId}-${Date.now()}-${idx}`,
        type: seg.type,
        start: seg.start,
        end: seg.end,
        spokenCue: seg.spokenCue,
      }));

      setVocalItems((prev) =>
        prev.map((v) =>
          v.id === itemId
            ? {
                ...v,
                jobState: 'completed',
                segments: mappedSegments,
                errorMessage: undefined,
              }
            : v
        )
      );
      setVocalProgress(itemId, '');
    } catch (err) {
      const message = err instanceof Error ? err.message : '人声识别请求失败';
      setVocalProgress(itemId, '');
      setVocalItems((prev) =>
        prev.map((v) =>
          v.id === itemId ? { ...v, jobState: 'error', errorMessage: message } : v
        )
      );
    }
  };

  const ensureCalibratedCopy = (session: QASessionItem): CalibrationResultItem => {
    if (session.calibratedResult) return session.calibratedResult;
    return {
      session_id: session.referenceJson.session_id,
      status: '已修正',
      summary: '人工微调校准',
      corrected_json: {
        ...session.referenceJson,
        transcripts: session.referenceJson.transcripts.map((u) => ({ ...u })),
      },
    };
  };

  const extraColumns = useMemo(() => {
    if (!activeSession) return [];
    const combined = [
      ...activeSession.referenceJson.transcripts,
      ...(activeSession.calibratedResult?.corrected_json.transcripts ?? []),
    ];
    return extractExtraUtteranceColumns(combined);
  }, [activeSession]);

  const availableRoles = useMemo(
    () => extractAllRoles(activeSession, sessions, customRoles),
    [activeSession, sessions, customRoles]
  );

  const recomputeStatus = (
    refTranscripts: Utterance[],
    curTranscripts: Utterance[],
    existingSummary: string,
    cols: string[]
  ): { status: '完全没错' | '已修正'; summary: string } => {
    const identical =
      refTranscripts.length === curTranscripts.length &&
      refTranscripts.every((r, idx) => {
        const c = curTranscripts[idx];
        return (
          r.utterance_id === c.utterance_id &&
          r.role === c.role &&
          Math.abs(r.start - c.start) < 0.005 &&
          Math.abs(r.end - c.end) < 0.005 &&
          r.text === c.text &&
          areUtteranceExtraFieldsEqual(r, c, cols)
        );
      });
    if (identical) {
      return { status: '完全没错', summary: '无修改' };
    }
    return {
      status: '已修正',
      summary: existingSummary === '无修改' ? '人工微调校准' : existingSummary,
    };
  };

  const resolveReferenceUtterance = useCallback(
    (session: QASessionItem, u: Utterance): Utterance | undefined => {
      const targetId = session.refAnchorMap
        ? session.refAnchorMap[u.utterance_id]
        : u.utterance_id;
      if (targetId === undefined) return undefined;
      return session.referenceJson.transcripts.find((r) => r.utterance_id === targetId);
    },
    []
  );

  const commitTranscriptsChange = useCallback(
    (
      sessionId: string,
      nextTranscripts: Utterance[],
      fallbackSummary = '人工微调校准',
      nextAnchorMap?: Record<number, number> | null
    ) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const base = ensureCalibratedCopy(s);
          const cols = extractExtraUtteranceColumns([
            ...s.referenceJson.transcripts,
            ...nextTranscripts,
          ]);
          const { status, summary } = recomputeStatus(
            s.referenceJson.transcripts,
            nextTranscripts,
            base.summary === '无修改' ? fallbackSummary : base.summary,
            cols
          );
          return {
            ...s,
            jobState: 'completed',
            refAnchorMap: nextAnchorMap === null ? undefined : (nextAnchorMap ?? s.refAnchorMap),
            calibratedResult: {
              ...base,
              status,
              summary,
              corrected_json: {
                ...base.corrected_json,
                transcripts: nextTranscripts,
              },
            },
            lastUpdatedAt: Date.now(),
          };
        })
      );
    },
    []
  );

  const handleUpdateUtterance = (updated: Utterance) => {
    if (!activeSession) return;
    const baseList =
      activeSession.calibratedResult?.corrected_json.transcripts ??
      activeSession.referenceJson.transcripts;
    const nextTranscripts = baseList.map((u) =>
      u.utterance_id === updated.utterance_id ? updated : u
    );
    commitTranscriptsChange(activeSession.id, nextTranscripts);
  };

  const handleRevertUtterance = (utteranceId: number) => {
    if (!activeSession) return;
    const list =
      activeSession.calibratedResult?.corrected_json.transcripts ??
      activeSession.referenceJson.transcripts;
    const current = list.find((u) => u.utterance_id === utteranceId);
    if (!current) return;
    const orig = resolveReferenceUtterance(activeSession, current);
    if (!orig) return;
    handleUpdateUtterance({ ...orig, utterance_id: utteranceId });
  };

  const buildCurrentAnchorMap = (session: QASessionItem, list: Utterance[]): Record<number, number> => {
    if (session.refAnchorMap) return { ...session.refAnchorMap };
    const map: Record<number, number> = {};
    for (const u of list) {
      map[u.utterance_id] = u.utterance_id;
    }
    return map;
  };

  const buildNewUtterance = (
    list: Utterance[],
    newId: number,
    start: number,
    end: number,
    defaultRole?: string
  ): Utterance => {
    const cols = extractExtraUtteranceColumns([
      ...(activeSession?.referenceJson.transcripts ?? []),
      ...list,
    ]);
    const extraDefaults: Record<string, unknown> = {};
    for (const col of cols) {
      extraDefaults[col] = '';
    }
    return {
      utterance_id: newId,
      role: defaultRole || availableRoles[0] || 'user',
      ...extraDefaults,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      text: '',
    };
  };

  const handleInsertUtteranceAtIndex = (
    insertIndex: number,
    explicitStart?: number,
    explicitEnd?: number
  ) => {
    if (!activeSession) return;
    const list =
      activeSession.calibratedResult?.corrected_json.transcripts ??
      activeSession.referenceJson.transcripts;
    const dur =
      activeSession.calibratedResult?.corrected_json.duration_sec ??
      activeSession.referenceJson.duration_sec;

    const clampedIdx = Math.max(0, Math.min(list.length, insertIndex));
    const prevU = clampedIdx > 0 ? list[clampedIdx - 1] : undefined;
    const nextU = clampedIdx < list.length ? list[clampedIdx] : undefined;

    let start = explicitStart;
    let end = explicitEnd;

    if (start === undefined || end === undefined) {
      if (prevU && nextU) {
        const gap = nextU.start - prevU.end;
        if (gap >= 0.2) {
          start = prevU.end;
          end = nextU.start;
        } else {
          start = prevU.end;
          end = Math.min(dur > 0 ? dur : prevU.end + 1.5, prevU.end + 1.5);
        }
      } else if (prevU) {
        start = prevU.end;
        end = Math.min(dur > 0 ? dur : prevU.end + 2, prevU.end + 2);
      } else if (nextU) {
        start = 0;
        end = nextU.start >= 0.2 ? nextU.start : Math.min(dur > 0 ? dur : 2, 2);
      } else {
        start = 0;
        end = Math.min(dur > 0 ? dur : 2, 2);
      }
      if (end <= start) {
        end = Number((start + 0.5).toFixed(2));
      }
    }

    const alternateRole =
      prevU && availableRoles.length > 1
        ? availableRoles.find((r) => r !== prevU.role) || prevU.role
        : availableRoles[0] || 'user';

    const oldAnchorMap = buildCurrentAnchorMap(activeSession, list);
    const newId = clampedIdx + 1;
    const created = buildNewUtterance(list, newId, start, end, alternateRole);

    const rawNext = [
      ...list.slice(0, clampedIdx),
      created,
      ...list.slice(clampedIdx),
    ];

    // Auto-renumber utterance_id sequentially (1..N) and preserve refAnchorMap for diffing
    const nextAnchorMap: Record<number, number> = {};
    const nextTranscripts = rawNext.map((u, idx) => {
      const seqId = idx + 1;
      if (idx !== clampedIdx) {
        const origRefId = oldAnchorMap[u.utterance_id];
        if (origRefId !== undefined) {
          nextAnchorMap[seqId] = origRefId;
        }
      }
      return {
        ...u,
        utterance_id: seqId,
      };
    });

    commitTranscriptsChange(activeSession.id, nextTranscripts, '新增/调整语句', nextAnchorMap);
    setActiveUtteranceId(newId);
    setAutoEditUtteranceId(newId);
    handleSeek(created.start);
  };

  const handleCreateUtteranceFromWaveform = (start: number, end: number) => {
    if (!activeSession) return;
    const list =
      activeSession.calibratedResult?.corrected_json.transcripts ??
      activeSession.referenceJson.transcripts;
    const idx = list.findIndex((u) => u.start > start);
    const insertIndex = idx === -1 ? list.length : idx;
    handleInsertUtteranceAtIndex(insertIndex, start, end);
  };

  const handleInsertAtPlayhead = () => {
    if (!activeSession) return;
    const dur =
      activeSession.calibratedResult?.corrected_json.duration_sec ??
      activeSession.referenceJson.duration_sec;
    const start = Math.max(0, Math.min(dur > 0.2 ? dur - 0.2 : currentTime, currentTime));
    const end = Math.min(dur > 0 ? dur : start + 2, Number((start + 2).toFixed(2)));
    handleCreateUtteranceFromWaveform(start, Math.max(Number((start + 0.3).toFixed(2)), end));
  };

  const handleDeleteUtterance = (utteranceId: number) => {
    if (!activeSession) return;
    const list =
      activeSession.calibratedResult?.corrected_json.transcripts ??
      activeSession.referenceJson.transcripts;
    const idx = list.findIndex((u) => u.utterance_id === utteranceId);
    if (idx < 0) return;
    const target = list[idx];
    const oldAnchorMap = buildCurrentAnchorMap(activeSession, list);
    const deletedOrigRefId = oldAnchorMap[target.utterance_id];

    const rawNext = list.filter((u) => u.utterance_id !== utteranceId);
    const nextAnchorMap: Record<number, number> = {};
    const nextTranscripts = rawNext.map((u, i) => {
      const seqId = i + 1;
      const origRefId = oldAnchorMap[u.utterance_id];
      if (origRefId !== undefined) {
        nextAnchorMap[seqId] = origRefId;
      }
      return {
        ...u,
        utterance_id: seqId,
      };
    });

    setLastDeletedEntry({
      sessionId: activeSession.id,
      index: idx,
      utterance: target,
      origRefId: deletedOrigRefId,
    });
    commitTranscriptsChange(activeSession.id, nextTranscripts, '删除/调整语句', nextAnchorMap);

    if (activeUtteranceId === utteranceId) {
      const fallback = nextTranscripts[idx] ?? nextTranscripts[idx - 1] ?? null;
      setActiveUtteranceId(fallback ? fallback.utterance_id : null);
    }
  };

  const handleUndoDelete = () => {
    if (!activeSession || !lastDeletedEntry || lastDeletedEntry.sessionId !== activeSession.id) {
      return;
    }
    const list =
      activeSession.calibratedResult?.corrected_json.transcripts ??
      activeSession.referenceJson.transcripts;
    const clampedIdx = Math.max(0, Math.min(list.length, lastDeletedEntry.index));
    const oldAnchorMap = buildCurrentAnchorMap(activeSession, list);

    const rawNext = [
      ...list.slice(0, clampedIdx),
      lastDeletedEntry.utterance,
      ...list.slice(clampedIdx),
    ];
    const nextAnchorMap: Record<number, number> = {};
    const nextTranscripts = rawNext.map((u, idx) => {
      const seqId = idx + 1;
      if (idx === clampedIdx) {
        if (lastDeletedEntry.origRefId !== undefined) {
          nextAnchorMap[seqId] = lastDeletedEntry.origRefId;
        }
      } else {
        const origRefId = oldAnchorMap[u.utterance_id];
        if (origRefId !== undefined) {
          nextAnchorMap[seqId] = origRefId;
        }
      }
      return {
        ...u,
        utterance_id: seqId,
      };
    });

    commitTranscriptsChange(activeSession.id, nextTranscripts, '撤销删除恢复语句', nextAnchorMap);
    setActiveUtteranceId(clampedIdx + 1);
    setLastDeletedEntry(null);
  };

  const displayedTranscripts = useMemo(() => {
    if (!activeSession) return [];
    const list =
      activeSession.calibratedResult?.corrected_json.transcripts ??
      activeSession.referenceJson.transcripts;

    return list.filter((u) => {
      if (filterMode === 'changed') {
        const ref = resolveReferenceUtterance(activeSession, u);
        const changed =
          !ref ||
          ref.text !== u.text ||
          ref.role !== u.role ||
          Math.abs(ref.start - u.start) >= 0.01 ||
          Math.abs(ref.end - u.end) >= 0.01 ||
          !areUtteranceExtraFieldsEqual(ref, u, extraColumns);
        if (!changed) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const extraMatch = extraColumns.some((col) => {
          const val = u[col];
          if (val === undefined || val === null) return false;
          const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
          return str.toLowerCase().includes(q);
        });
        return (
          u.text.toLowerCase().includes(q) ||
          u.role.toLowerCase().includes(q) ||
          String(u.utterance_id).includes(q) ||
          extraMatch
        );
      }
      return true;
    });
  }, [activeSession, filterMode, searchQuery, extraColumns, resolveReferenceUtterance]);

  const isAnyProcessing = sessions.some((s) => s.jobState === 'processing');

  const handleExportVocalCsv = () => {
    if (vocalItems.length === 0) return;
    const esc = (v: string) =>
      v.includes(',') || v.includes('"') || v.includes('\n')
        ? `"${v.replace(/"/g, '""')}"`
        : v;
    const header = ['QueryID', '时长（s）', '正常_人声段', '耳语_人声段', '气声_人声段'];
    const lines = [
      header.map(esc).join(','),
      ...vocalItems.map((it) => {
        const f = computeVocalRowFields(it, '-');
        return [f.queryId, f.diffDuration, f.normalRange, f.whisperRange, f.breathyRange]
          .map(esc)
          .join(',');
      }),
    ];
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vocal_segments_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`min-h-screen flex flex-col bg-slate-50 text-slate-900 ${activeTab === 'workbench' ? 'lg:h-dvh lg:overflow-hidden' : ''}`}>
      {/* Top Bar Contract: 3 zones, single row, gap-8 */}
      <header className="h-14 px-6 bg-white border-b border-slate-200 flex items-center justify-between gap-8 shrink-0 sticky top-0 z-30">
        {/* Zone 1: Single text element wordmark */}
        <button
          type="button"
          onClick={() => setActiveTab('workbench')}
          className="text-base font-bold tracking-tight text-slate-900 font-display whitespace-nowrap shrink-0 cursor-pointer"
        >
          ASR 校准台
        </button>

        {/* Zone 2: 5 single-line text nav links */}
        <nav className="flex items-center gap-4 md:gap-6 text-sm font-medium overflow-x-auto">
          {(
            [
              { id: 'workbench', label: '质检工作台' },
              { id: 'vocal', label: '人声段标注' },
              { id: 'batch', label: '批量汇总' },
              { id: 'rules', label: '校准规则' },
              { id: 'export', label: 'JSON 导出' },
            ] as const
          ).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`py-4 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'border-blue-700 text-slate-900'
                    : 'border-transparent text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center shrink-0">
          {activeTab === 'vocal' ? (
            <button
              type="button"
              disabled={vocalItems.length === 0}
              onClick={handleExportVocalCsv}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-blue-700 text-white rounded-md hover:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>导出表格 CSV</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={sessions.length === 0 || isAnyProcessing}
              onClick={handleRunBatch}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-blue-700 text-white rounded-md hover:bg-blue-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isAnyProcessing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              <span>{isAnyProcessing ? '正在核对...' : '运行批量质检'}</span>
            </button>
          )}
        </div>
      </header>

      {historyError && (
        <div role="alert" className="px-6 py-2 text-sm text-rose-800 bg-rose-50 border-b border-rose-200">
          本地历史记录操作失败：{historyError}
        </div>
      )}

      {/* Main Content */}
      {activeTab === 'vocal' && (
        <VocalSegmentWorkbench
          items={vocalItems}
          selectedId={selectedVocalId}
          progressMap={vocalProgressMap}
          onSelectId={setSelectedVocalId}
          onAddItems={(newItems) => void handleAddVocalItems(newItems)}
          onUpdateItem={(id, updater) =>
            setVocalItems((prev) => prev.map((it) => (it.id === id ? updater(it) : it)))
          }
          onRemoveItem={(id) => {
            setVocalItems((prev) => {
              const target = prev.find((it) => it.id === id);
              if (target?.audioUrl) {
                URL.revokeObjectURL(target.audioUrl);
              }
              const next = prev.filter((it) => it.id !== id);
              if (selectedVocalId === id) {
                setSelectedVocalId(next[0]?.id ?? null);
              }
              return next;
            });
          }}
          onDetectItem={runVocalDetectionForItem}
        />
      )}

      {activeTab === 'rules' && (
        <main className="flex-1 overflow-y-auto">
          <RulesAndGlossaryView
            customRules={customRules}
            onChangeCustomRules={setCustomRules}
          />
        </main>
      )}

      {activeTab === 'batch' && (
        <main className="flex-1 overflow-y-auto">
          {historyStoragePath && (
            <div className="max-w-6xl mx-auto mt-6 px-6 text-xs text-slate-600">
              本地作业和音频保存在：<code className="break-all">{historyStoragePath}</code>
              <span className="ml-2">手动删除该文件夹即可清除所有历史。</span>
            </div>
          )}
          <BatchSummaryView
            sessions={sessions}
            onOpenSession={(id) => {
              setSelectedId(id);
              setActiveTab('workbench');
            }}
            onRunSession={runCalibrationForSession}
            onRemoveSession={handleRemoveSession}
          />
        </main>
      )}

      {activeTab === 'export' && (
        <main className="flex-1 max-w-6xl w-full mx-auto py-6 px-6">
          <div className="h-[calc(100vh-8rem)]">
            <JsonInspectorPanel
              activeSession={activeSession}
              allSessions={sessions}
              onSelectUtterance={(uid) => {
                setActiveUtteranceId(uid);
                setActiveTab('workbench');
              }}
            />
          </div>
        </main>
      )}

      {activeTab === 'workbench' && (
        <div className="flex-1 flex flex-col lg:flex-row min-h-0">
          {/* Left Batch Queue Sidebar (272px) */}
          <aside className="w-full lg:w-[272px] min-h-0 shrink-0 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 flex flex-col">
            <div className="shrink-0 p-4 border-b border-slate-200 space-y-2.5">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-slate-700">
                  质检任务队列 ({sessions.length})
                </h2>
                <button
                  type="button"
                  onClick={() => setIsImportOpen(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 rounded transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>导入样本</span>
                </button>
              </div>

              <button
                type="button"
                disabled={isGeneratingDemo}
                onClick={handleGenerateDemoSample}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors disabled:opacity-50 cursor-pointer whitespace-nowrap shrink-0"
              >
                {isGeneratingDemo ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-700" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 text-blue-700" />
                )}
                <span>{isGeneratingDemo ? '正在合成示例语音...' : '生成真实语音示例'}</span>
              </button>

              {demoError && (
                <p className="text-[11px] text-rose-700 leading-snug">{demoError}</p>
              )}
            </div>

            <div className="shrink-0 border-b border-slate-200 px-4 py-2 text-[11px] text-slate-600">
              <div className="font-medium text-slate-700">文件保存地址</div>
              {historyStoragePath ? (
                <code className="block select-all break-all">{historyStoragePath}</code>
              ) : (
                <span>{historyError ? '无法读取保存地址' : '正在读取保存地址…'}</span>
              )}
            </div>

            <div role="region" aria-label="质检任务列表" tabIndex={0} className="min-h-0 max-h-[40dvh] lg:max-h-none flex-1 overflow-y-auto overscroll-y-contain divide-y divide-slate-100">
              {sessions.length === 0 ? (
                <div className="p-5 text-xs text-slate-500 leading-relaxed">
                  暂无音频样本。点击上方「导入样本」上传音频与参考 JSON，或生成一条带真实人声对话的示例样本。
                </div>
              ) : (
                sessions.map((item) => {
                  const selected = activeSession?.id === item.id;
                  const statusText =
                    item.jobState === 'processing'
                      ? '校准中'
                      : item.jobState === 'error'
                        ? '异常'
                        : item.calibratedResult
                          ? item.calibratedResult.status
                          : '待检';

                  return (
                    <div
                      key={item.id}
                      onClick={() => {
                        setSelectedId(item.id);
                        setActiveUtteranceId(null);
                        setCurrentTime(0);
                      }}
                      className={`p-3.5 cursor-pointer transition-colors ${
                        selected ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-mono font-semibold text-slate-900 truncate">
                            {item.referenceJson.session_id}
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500 truncate">
                            {item.audioName}
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveSession(item.id);
                          }}
                          title="移除样本"
                          className="p-1 text-slate-400 hover:text-rose-700 rounded cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="mt-2 flex items-center justify-between text-[11px]">
                        <span className="font-mono tabular-nums text-slate-500">
                          {formatSec(item.referenceJson.duration_sec)} ·{' '}
                          {item.referenceJson.transcripts.length} 条
                        </span>

                        {item.jobState === 'processing' && (
                          <span className="inline-flex items-center gap-1 text-blue-700 font-medium">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>{statusText}</span>
                          </span>
                        )}
                        {item.jobState === 'error' && (
                          <span className="inline-flex items-center gap-1 text-rose-700 font-medium">
                            <AlertCircle className="w-3 h-3" />
                            <span>{statusText}</span>
                          </span>
                        )}
                        {item.jobState === 'pending' && (
                          <span className="inline-flex items-center gap-1 text-slate-500">
                            <Clock className="w-3 h-3" />
                            <span>{statusText}</span>
                          </span>
                        )}
                        {item.jobState === 'completed' && item.calibratedResult && (
                          <span
                            className={`inline-flex items-center gap-1 font-medium ${
                              item.calibratedResult.status === '已修正'
                                ? 'text-blue-700'
                                : 'text-emerald-700'
                            }`}
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            <span>{statusText}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </aside>

          {/* Center Calibration Workspace */}
          <main className="flex-1 min-h-0 min-w-0 p-5 lg:overflow-y-auto lg:overscroll-y-contain space-y-5">
            {!activeSession ? (
              <div className="max-w-2xl mx-auto mt-12 bg-white border border-slate-200 rounded-xl p-8 text-center space-y-5">
                <div className="w-11 h-11 mx-auto rounded-lg bg-slate-100 flex items-center justify-center text-blue-700">
                  <FileAudio className="w-5 h-5" />
                </div>
                <div className="space-y-2">
                  <h1 className="text-lg font-semibold text-slate-900 font-display">
                    以真实音频为绝对标准的 ASR 转写质检工作台
                  </h1>
                  <p className="text-sm text-slate-600 leading-relaxed max-w-lg mx-auto">
                    上传原始音频与待核对的参考 JSON，自动逐帧核对错别字、漏字吞字、真实语气词、口吃改口与说话人角色，默认锁定准确的原 VAD 时间轴，并完整导出零省略 JSON。
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsImportOpen(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-blue-700 text-white rounded-md hover:bg-blue-800 transition-colors cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>上传 ZIP 批量包或音频与 JSON</span>
                  </button>
                  <button
                    type="button"
                    disabled={isGeneratingDemo}
                    onClick={handleGenerateDemoSample}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {isGeneratingDemo ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-700" />
                    ) : (
                      <Sparkles className="w-3.5 h-3.5 text-blue-700" />
                    )}
                    <span>生成真实语音质检示例</span>
                  </button>
                </div>

                {demoError && (
                  <p className="text-xs text-rose-700">{demoError}</p>
                )}
              </div>
            ) : (
              <>
                {/* Quiet Metadata Header & Single Session Run */}
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-500 font-mono tabular-nums">
                      <span className="text-sm font-semibold text-slate-900">
                        {activeSession.referenceJson.session_id}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{activeSession.audioName}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        时长{' '}
                        {formatSec(
                          activeSession.calibratedResult?.corrected_json.duration_sec ??
                            activeSession.referenceJson.duration_sec
                        )}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {(
                          activeSession.calibratedResult?.corrected_json.transcripts ??
                          activeSession.referenceJson.transcripts
                        ).length}{' '}
                        条语句
                      </span>
                    </div>

                    {activeSession.jobState === 'processing' && progressMap[activeSession.id] ? (
                      <div className="flex items-center gap-2 text-xs text-blue-700 font-medium">
                        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                        <span>{progressMap[activeSession.id]}</span>
                      </div>
                    ) : activeSession.errorMessage ? (
                      <div className="flex items-center gap-2 text-xs text-rose-700">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>{activeSession.errorMessage}</span>
                      </div>
                    ) : activeSession.calibratedResult ? (
                      <p className="text-xs text-slate-600 leading-relaxed">
                        <span
                          className={`font-semibold mr-2 ${
                            activeSession.calibratedResult.status === '已修正'
                              ? 'text-blue-700'
                              : 'text-emerald-700'
                          }`}
                        >
                          [{activeSession.calibratedResult.status}]
                        </span>
                        {activeSession.calibratedResult.summary}
                      </p>
                    ) : (
                      <p className="text-xs text-slate-500">
                        当前显示参考转写数据，点击右侧「核对当前音频」启动帧级校准（100MB+ 大音频自动分片上传）。
                      </p>
                    )}
                  </div>

                  <button
                    type="button"
                    disabled={activeSession.jobState === 'processing'}
                    onClick={() => runCalibrationForSession(activeSession.id)}
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {activeSession.jobState === 'processing' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {activeSession.jobState === 'processing'
                        ? progressMap[activeSession.id] || 'AI 逐帧核对中...'
                        : activeSession.calibratedResult
                          ? '重新核对当前音频'
                          : '核对当前音频'}
                    </span>
                  </button>
                </div>

                {/* Waveform Scrubbing Player */}
                <WaveformPlayer
                  audioUrl={activeSession.audioUrl}
                  audioSize={activeSession.audioSize}
                  durationSec={
                    activeSession.calibratedResult?.corrected_json.duration_sec ??
                    activeSession.referenceJson.duration_sec
                  }
                  utterances={
                    activeSession.calibratedResult?.corrected_json.transcripts ??
                    activeSession.referenceJson.transcripts
                  }
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
                  onSelectUtterance={(id) => setActiveUtteranceId(id)}
                  onUpdateUtteranceBounds={(uid, start, end) => {
                    const list =
                      activeSession.calibratedResult?.corrected_json.transcripts ??
                      activeSession.referenceJson.transcripts;
                    const target = list.find((u) => u.utterance_id === uid);
                    if (target) {
                      handleUpdateUtterance({ ...target, start, end });
                    }
                  }}
                  onCreateSegmentRange={handleCreateUtteranceFromWaveform}
                  rangeActionLabel="框选新增"
                  audioRef={audioRef}
                />

                {/* Split: Utterance Diff Grid + JSON Output Inspector */}
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
                  {/* Utterance Table (8 cols on xl) */}
                  <div className="xl:col-span-8 bg-white border border-slate-200 rounded-lg overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-200 space-y-2">
                      <label htmlFor="qa-quick-edit" className="block text-sm font-medium text-slate-900">
                        {selectedUtterance ? `编辑语句 #${selectedUtterance.utterance_id}` : '编辑选中语句'}
                      </label>
                      <textarea
                        id="qa-quick-edit"
                        ref={quickEditRef}
                        rows={3}
                        disabled={!selectedUtterance}
                        placeholder={selectedUtterance ? '输入语句文本' : '点击波形上的语句块或下方表格中的语句'}
                        value={selectedUtterance?.text ?? ''}
                        onChange={(event) => {
                          if (selectedUtterance) {
                            handleUpdateUtterance({ ...selectedUtterance, text: event.currentTarget.value });
                          }
                        }}
                        className="block w-full resize-y rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
                      />
                    </div>
                    <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
                          <button
                            type="button"
                            onClick={() => setFilterMode('all')}
                            className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                              filterMode === 'all'
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            全部语句
                          </button>
                          <button
                            type="button"
                            onClick={() => setFilterMode('changed')}
                            className={`px-3 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                              filterMode === 'changed'
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            仅看有改动
                          </button>
                        </div>

                        <div
                          className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md"
                          title="控制 AI 核对时如何处理原始 start/end 时间戳"
                        >
                          <button
                            type="button"
                            onClick={() => setTimestampMode('lock')}
                            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                              timestampMode === 'lock'
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            锁定原时间戳
                          </button>
                          <button
                            type="button"
                            onClick={() => setTimestampMode('conservative')}
                            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                              timestampMode === 'conservative'
                                ? 'bg-white text-slate-900 shadow-xs'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            仅微调明显错位（禁顺延）
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={handleInsertAtPlayhead}
                          title={`按当前播放位置 (${currentTime.toFixed(2)}s) 插入新语句并自动顺延编号（也可在波形图开启「框选新增」或按住 Shift 拖拽选段）`}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>当前位置新增</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleInsertUtteranceAtIndex(0)}
                          title="在列表最上方（第一条之前）插入新语句并自动顺延编号"
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>开头插入</span>
                        </button>

                        <div className="relative">
                          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                          <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder={
                              extraColumns.length > 0
                                ? `搜索文本、role、${extraColumns.slice(0, 2).join('/')} 或 ID...`
                                : '搜索文本、role 或 ID...'
                            }
                            className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 w-48"
                          />
                        </div>
                      </div>
                    </div>

                    {lastDeletedEntry && lastDeletedEntry.sessionId === activeSession.id && (
                      <div className="px-4 py-2 border-b border-amber-200 bg-amber-50/70 flex items-center justify-between text-xs text-amber-900">
                        <span>
                          已删除语句 #{lastDeletedEntry.utterance.utterance_id}
                          {lastDeletedEntry.utterance.text
                            ? `（${lastDeletedEntry.utterance.text.slice(0, 24)}${lastDeletedEntry.utterance.text.length > 24 ? '…' : ''}）`
                            : ''}
                          ，后续 ID 已自动顺延更新
                        </span>
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            onClick={handleUndoDelete}
                            className="inline-flex items-center gap-1 font-medium text-blue-700 hover:underline cursor-pointer"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>撤销删除</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setLastDeletedEntry(null)}
                            className="text-slate-500 hover:text-slate-800 cursor-pointer"
                          >
                            关闭
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-medium text-slate-500">
                            <th className="py-2.5 pl-4 pr-2 whitespace-nowrap">ID</th>
                            <th className="py-2.5 px-3 whitespace-nowrap">说话人 Role</th>
                            {extraColumns.map((col) => (
                              <th
                                key={col}
                                className="py-2.5 px-2.5 font-mono text-slate-600 whitespace-nowrap"
                              >
                                {col}
                              </th>
                            ))}
                            <th className="py-2.5 px-3 whitespace-nowrap">时间轴 Start – End</th>
                            <th className="py-2.5 px-3 whitespace-nowrap">
                              字词精修与增删（双击编辑 · + 下方插入）
                            </th>
                            <th className="py-2.5 pl-2 pr-4 text-right whitespace-nowrap">
                              核对状态
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {displayedTranscripts.length === 0 ? (
                            <tr>
                              <td
                                colSpan={5 + extraColumns.length}
                                className="py-10 text-center text-xs text-slate-500 space-y-2"
                              >
                                <div>
                                  {filterMode === 'changed'
                                    ? '当前会话没有发现改动项。'
                                    : '暂无语句条目，可直接点击下方按钮或在波形图框选新增。'}
                                </div>
                                {filterMode === 'all' && !searchQuery.trim() && (
                                  <button
                                    type="button"
                                    onClick={() => handleInsertUtteranceAtIndex(0)}
                                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md cursor-pointer"
                                  >
                                    <Plus className="w-3.5 h-3.5" />
                                    <span>新增第一条语句</span>
                                  </button>
                                )}
                              </td>
                            </tr>
                          ) : (
                            displayedTranscripts.map((u) => {
                              const refU = resolveReferenceUtterance(activeSession, u);
                              const fullList =
                                activeSession.calibratedResult?.corrected_json.transcripts ??
                                activeSession.referenceJson.transcripts;
                              const realIndex = fullList.findIndex(
                                (item) => item.utterance_id === u.utterance_id
                              );
                              return (
                                <UtteranceRow
                                  key={u.utterance_id}
                                  utterance={u}
                                  referenceUtterance={refU}
                                  durationSec={
                                    activeSession.calibratedResult?.corrected_json.duration_sec ??
                                    activeSession.referenceJson.duration_sec
                                  }
                                  extraColumns={extraColumns}
                                  availableRoles={availableRoles}
                                  isActive={activeUtteranceId === u.utterance_id}
                                  isPlaying={isPlaying}
                                  autoEdit={autoEditUtteranceId === u.utterance_id}
                                  onAutoEditConsumed={() => setAutoEditUtteranceId(null)}
                                  onPlaySegment={handlePlaySegment}
                                  onSelect={(id) => setActiveUtteranceId(id)}
                                  onUpdate={handleUpdateUtterance}
                                  onRevert={handleRevertUtterance}
                                  onInsertAfter={() =>
                                    handleInsertUtteranceAtIndex(
                                      realIndex >= 0 ? realIndex + 1 : fullList.length
                                    )
                                  }
                                  onDelete={handleDeleteUtterance}
                                  onAddCustomRole={(newRole) =>
                                    setCustomRoles((prev) =>
                                      prev.includes(newRole) ? prev : [...prev, newRole]
                                    )
                                  }
                                />
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* JSON Schema Output Panel (4 cols on xl) */}
                  <div className="xl:col-span-4 xl:h-[580px]">
                    <JsonInspectorPanel
                      activeSession={activeSession}
                      allSessions={sessions}
                      onSelectUtterance={(uid) => {
                        setActiveUtteranceId(uid);
                        const hit = (
                          activeSession.calibratedResult?.corrected_json.transcripts ??
                          activeSession.referenceJson.transcripts
                        ).find((u) => u.utterance_id === uid);
                        if (hit) handleSeek(hit.start);
                      }}
                    />
                  </div>
                </div>
              </>
            )}
          </main>
        </div>
      )}

      <ImportSessionModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        onAddSessions={handleAddSessions}
      />
    </div>
  );
}
