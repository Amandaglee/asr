import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Focus,
  Maximize2,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  SkipBack,
  SkipForward,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Utterance } from '../types/asr';
import { formatSec } from '../utils/diff';

interface WaveformPlayerProps {
  audioUrl: string;
  audioSize?: number;
  durationSec: number;
  utterances: Utterance[];
  activeUtteranceId: number | null;
  currentTime: number;
  isPlaying: boolean;
  loopSegment: boolean;
  playbackRate: number;
  onTimeUpdate: (time: number) => void;
  onPlayStateChange: (playing: boolean) => void;
  onToggleLoopSegment: () => void;
  onPlaybackRateChange: (rate: number) => void;
  onSeek: (time: number) => void;
  onSelectUtterance: (id: number) => void;
  onUpdateUtteranceBounds?: (id: number, start: number, end: number) => void;
  onCreateSegmentRange?: (start: number, end: number) => void;
  rangeActionLabel?: string;
  audioRef: React.RefObject<HTMLAudioElement | null>;
}

const ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64] as const;

type GainMode = 'auto' | 1 | 2 | 5 | 10;

export const WaveformPlayer: React.FC<WaveformPlayerProps> = ({
  audioUrl,
  audioSize = 0,
  durationSec,
  utterances,
  activeUtteranceId,
  currentTime,
  isPlaying,
  loopSegment,
  playbackRate,
  onTimeUpdate,
  onPlayStateChange,
  onToggleLoopSegment,
  onPlaybackRateChange,
  onSeek,
  onSelectUtterance,
  onUpdateUtteranceBounds,
  onCreateSegmentRange,
  rangeActionLabel = '框选打段',
  audioRef,
}) => {
  const [actualDuration, setActualDuration] = useState<number>(durationSec);
  const [decodeState, setDecodeState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [zoom, setZoom] = useState<number>(1);
  const [viewStart, setViewStart] = useState<number>(0);
  const [gainMode, setGainMode] = useState<GainMode>('auto');
  const [followPlayhead, setFollowPlayhead] = useState<boolean>(true);
  const [interactionMode, setInteractionMode] = useState<'scrub' | 'range'>('scrub');
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [canvasWidth, setCanvasWidth] = useState<number>(800);

  const channelDataRef = useRef<Float32Array | null>(null);
  const sampleRateRef = useRef<number>(44100);
  const autoGainRef = useRef<number>(1);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);

  const [dragMode, setDragMode] = useState<
    | null
    | { kind: 'scrub' }
    | { kind: 'range'; anchorTime: number; currentEdgeTime: number }
    | { kind: 'minimap'; anchorOffsetSec: number }
    | { kind: 'handle'; utteranceId: number; edge: 'start' | 'end' }
  >(null);

  const effectiveDuration = actualDuration > 0 ? actualDuration : Math.max(durationSec, 1);
  const visibleDuration = Math.max(0.2, effectiveDuration / zoom);
  const maxViewStart = Math.max(0, effectiveDuration - visibleDuration);
  const clampedViewStart = Math.max(0, Math.min(maxViewStart, viewStart));
  const viewEnd = Math.min(effectiveDuration, clampedViewStart + visibleDuration);

  // Reset zoom/scroll when switching audio file
  useEffect(() => {
    setZoom(1);
    setViewStart(0);
    setActualDuration(durationSec);
  }, [audioUrl, durationSec]);

  // Clamp viewStart when duration or zoom changes
  useEffect(() => {
    setViewStart((prev) => Math.max(0, Math.min(maxViewStart, prev)));
  }, [maxViewStart]);

  // Long or large files use lower-rate PCM for waveform rendering to reduce memory usage.
  useEffect(() => {
    const controller = new AbortController();
    channelDataRef.current = null;

    if (!audioUrl) {
      setDecodeState('idle');
      return;
    }

    setDecodeState('loading');

    async function decodeFullAudio() {
      try {
        const res = await fetch(audioUrl, { signal: controller.signal });
        if (!res.ok) throw new Error(`Audio request failed: ${res.status}`);
        const arrayBuf = await res.arrayBuffer();
        if (controller.signal.aborted) return;
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const useLowerSampleRate = audioSize > 35 * 1024 * 1024 || durationSec > 300;
        const ctx = useLowerSampleRate ? new AudioCtx({ sampleRate: 8000 }) : new AudioCtx();
        try {
          const decoded = await ctx.decodeAudioData(arrayBuf);
          if (controller.signal.aborted) return;

          const dur = decoded.duration || durationSec;
          setActualDuration(dur);

          // Mix down to mono peak envelope if stereo, or take channel 0 directly
          const ch0 = decoded.getChannelData(0);
          let samples = ch0;
          if (decoded.numberOfChannels > 1) {
            const ch1 = decoded.getChannelData(1);
            const mixed = new Float32Array(ch0.length);
            for (let i = 0; i < ch0.length; i++) {
              mixed[i] = Math.abs(ch0[i]) >= Math.abs(ch1[i]) ? ch0[i] : ch1[i];
            }
            samples = mixed;
          }

          channelDataRef.current = samples;
          sampleRateRef.current = decoded.sampleRate;

          // Compute 98th percentile amplitude across 400 blocks so whisper/breathy clips stay visible
          const blockCount = 400;
          const step = Math.max(1, Math.floor(samples.length / blockCount));
          const blockPeaks: number[] = [];
          for (let i = 0; i < samples.length; i += step) {
            let maxAbs = 0;
            const end = Math.min(samples.length, i + step);
            const innerStep = Math.max(1, Math.floor((end - i) / 64));
            for (let j = i; j < end; j += innerStep) {
              const a = Math.abs(samples[j]);
              if (a > maxAbs) maxAbs = a;
            }
            blockPeaks.push(maxAbs);
          }
          blockPeaks.sort((a, b) => a - b);
          const p98 = blockPeaks[Math.floor(blockPeaks.length * 0.98)] ?? 0.5;
          const pMax = blockPeaks[blockPeaks.length - 1] ?? 0.5;
          const refPeak = Math.max(p98, pMax * 0.75);
          // Cap gain between 1 and 18 so pure floor noise isn't blown up
          autoGainRef.current = refPeak > 0.004 ? Math.min(18, Math.max(1, 0.88 / refPeak)) : 1;

          setDecodeState('ready');
        } finally {
          ctx.close().catch(() => {});
        }
      } catch {
        if (!controller.signal.aborted) {
          setDecodeState('error');
        }
      }
    }

    decodeFullAudio();
    return () => {
      controller.abort();
    };
  }, [audioUrl, audioSize, durationSec]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, audioRef]);

  const activeUtterance = useMemo(
    () => utterances.find((u) => u.utterance_id === activeUtteranceId) || null,
    [utterances, activeUtteranceId]
  );

  // Loop segment enforcement
  useEffect(() => {
    if (!loopSegment || !activeUtterance || !isPlaying || !audioRef.current) return;
    if (currentTime >= activeUtterance.end) {
      audioRef.current.currentTime = activeUtterance.start;
    }
  }, [currentTime, loopSegment, activeUtterance, isPlaying, audioRef]);

  // Auto-follow playhead while playing when zoomed in
  useEffect(() => {
    if (!followPlayhead || !isPlaying || zoom <= 1) return;
    if (currentTime < clampedViewStart || currentTime > viewEnd - visibleDuration * 0.08) {
      const nextStart = Math.max(
        0,
        Math.min(maxViewStart, currentTime - visibleDuration * 0.18)
      );
      setViewStart(nextStart);
    }
  }, [currentTime, followPlayhead, isPlaying, zoom, clampedViewStart, viewEnd, visibleDuration, maxViewStart]);

  // Observe track container width for crisp canvas DPR rendering
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const updateWidth = () => {
      const w = Math.floor(el.clientWidth);
      if (w > 0) setCanvasWidth(w);
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Draw crisp high-resolution waveform onto <canvas> for [clampedViewStart, viewEnd]
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(100, canvasWidth);
    const height = 104;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Subtle center baseline
    const midY = height / 2;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    const samples = channelDataRef.current;
    const sr = sampleRateRef.current;
    const gain = gainMode === 'auto' ? autoGainRef.current : gainMode;
    const progressRatio = Math.max(0, Math.min(1, (currentTime - clampedViewStart) / visibleDuration));
    const progressX = progressRatio * width;

    if (samples && samples.length > 0 && decodeState === 'ready') {
      const startSample = Math.max(0, Math.floor(clampedViewStart * sr));
      const endSample = Math.min(samples.length, Math.ceil(viewEnd * sr));
      const totalVisibleSamples = Math.max(1, endSample - startSample);
      const barStep = 2; // 2px resolution for dense crisp bars
      const halfMax = midY - 6;

      for (let x = 0; x < width; x += barStep) {
        const s0 = startSample + Math.floor((x / width) * totalVisibleSamples);
        const s1 = Math.max(
          s0 + 1,
          startSample + Math.floor(((x + barStep) / width) * totalVisibleSamples)
        );
        const clampedS1 = Math.min(samples.length, s1);

        let maxPos = 0;
        let maxNeg = 0;
        // Stride cleanly if huge zoom-out block, scan every sample when zoomed in
        const stride = Math.max(1, Math.floor((clampedS1 - s0) / 160));
        for (let i = s0; i < clampedS1; i += stride) {
          const v = samples[i];
          if (v > maxPos) maxPos = v;
          if (v < maxNeg) maxNeg = v;
        }

        const ampTop = Math.min(1, Math.pow(Math.min(1, maxPos * gain), 0.78));
        const ampBot = Math.min(1, Math.pow(Math.min(1, Math.abs(maxNeg) * gain), 0.78));
        const topH = Math.max(1, ampTop * halfMax);
        const botH = Math.max(1, ampBot * halfMax);

        ctx.fillStyle = x <= progressX ? '#2563eb' : '#94a3b8';
        ctx.fillRect(x, midY - topH, 1.5, topH + botH);
      }
    }

    ctx.restore();
  }, [
    canvasWidth,
    decodeState,
    clampedViewStart,
    viewEnd,
    visibleDuration,
    currentTime,
    gainMode,
  ]);

  const applyZoomAtRatio = useCallback(
    (nextZoom: number, anchorRatio = 0.5) => {
      const clampedZoom = Math.max(1, Math.min(64, Number(nextZoom.toFixed(2))));
      const anchorTime = clampedViewStart + anchorRatio * visibleDuration;
      const nextVisDur = Math.max(0.2, effectiveDuration / clampedZoom);
      const nextMaxStart = Math.max(0, effectiveDuration - nextVisDur);
      const nextStart = Math.max(0, Math.min(nextMaxStart, anchorTime - anchorRatio * nextVisDur));
      setZoom(clampedZoom);
      setViewStart(nextStart);
    },
    [clampedViewStart, visibleDuration, effectiveDuration]
  );

  // Wheel zoom & pan directly over the waveform
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        const panSec = (delta / rect.width) * visibleDuration * 0.85;
        setViewStart((prev) => Math.max(0, Math.min(maxViewStart, prev + panSec)));
        return;
      }

      const factor = e.deltaY < 0 ? 1.35 : 1 / 1.35;
      applyZoomAtRatio(zoom * factor, ratio);
    };

    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [zoom, visibleDuration, maxViewStart, applyZoomAtRatio]);

  const timeFromClientX = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return currentTime;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Number((clampedViewStart + ratio * visibleDuration).toFixed(2));
    },
    [clampedViewStart, visibleDuration, currentTime]
  );

  useEffect(() => {
    if (!dragMode) return;
    const handleMove = (e: MouseEvent) => {
      if (dragMode.kind === 'scrub') {
        onSeek(timeFromClientX(e.clientX));
      } else if (dragMode.kind === 'range') {
        const cur = Math.max(0, Math.min(effectiveDuration, timeFromClientX(e.clientX)));
        setDragMode((prev) =>
          prev && prev.kind === 'range' ? { ...prev, currentEdgeTime: cur } : prev
        );
      } else if (dragMode.kind === 'minimap' && minimapRef.current) {
        const rect = minimapRef.current.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const targetStart = ratio * effectiveDuration - dragMode.anchorOffsetSec;
        setViewStart(Math.max(0, Math.min(maxViewStart, targetStart)));
      } else if (dragMode.kind === 'handle' && onUpdateUtteranceBounds) {
        const targetU = utterances.find((u) => u.utterance_id === dragMode.utteranceId);
        if (!targetU) return;
        const t = Math.max(0, Math.min(effectiveDuration, timeFromClientX(e.clientX)));
        if (dragMode.edge === 'start') {
          const safeStart = Math.min(t, Number((targetU.end - 0.05).toFixed(2)));
          onUpdateUtteranceBounds(targetU.utterance_id, Math.max(0, safeStart), targetU.end);
        } else {
          const safeEnd = Math.max(t, Number((targetU.start + 0.05).toFixed(2)));
          onUpdateUtteranceBounds(
            targetU.utterance_id,
            targetU.start,
            Math.min(effectiveDuration, safeEnd)
          );
        }
      }
    };
    const handleUp = () => {
      if (dragMode.kind === 'range' && onCreateSegmentRange) {
        const s = Number(Math.min(dragMode.anchorTime, dragMode.currentEdgeTime).toFixed(2));
        const e = Number(Math.max(dragMode.anchorTime, dragMode.currentEdgeTime).toFixed(2));
        if (e - s >= 0.05) {
          onCreateSegmentRange(s, e);
        } else {
          onSeek(s);
        }
      }
      setDragMode(null);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [
    dragMode,
    timeFromClientX,
    onSeek,
    effectiveDuration,
    maxViewStart,
    utterances,
    onUpdateUtteranceBounds,
    onCreateSegmentRange,
  ]);

  const focusActiveSegment = () => {
    if (!activeUtterance) return;
    const segLen = Math.max(0.4, activeUtterance.end - activeUtterance.start);
    const desiredVis = Math.max(0.6, segLen * 1.6);
    const nextZoom = Math.max(1, Math.min(64, Number((effectiveDuration / desiredVis).toFixed(2))));
    const actualVis = effectiveDuration / nextZoom;
    const nextStart = Math.max(
      0,
      Math.min(
        Math.max(0, effectiveDuration - actualVis),
        activeUtterance.start - (actualVis - segLen) / 2
      )
    );
    setZoom(nextZoom);
    setViewStart(nextStart);
  };

  // Compute adaptive ruler ticks for [clampedViewStart, viewEnd]
  const rulerTicks = useMemo(() => {
    const rawStep = visibleDuration / 8;
    const niceSteps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = niceSteps.find((s) => s >= rawStep) ?? 120;
    const firstTick = Math.ceil(clampedViewStart / step) * step;
    const ticks: Array<{ time: number; leftPct: number }> = [];
    for (let t = firstTick; t <= viewEnd + 0.0001; t += step) {
      const pct = ((t - clampedViewStart) / visibleDuration) * 100;
      if (pct >= 0 && pct <= 100) {
        ticks.push({ time: Number(t.toFixed(2)), leftPct: pct });
      }
    }
    return ticks;
  }, [clampedViewStart, viewEnd, visibleDuration]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  };

  const playheadPct = ((currentTime - clampedViewStart) / visibleDuration) * 100;
  const playheadInView = playheadPct >= 0 && playheadPct <= 100;

  return (
    <div className="border border-slate-200 bg-white rounded-lg p-4 space-y-2.5">
      <audio
        ref={audioRef}
        src={audioUrl}
        onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
        onPlay={() => onPlayStateChange(true)}
        onPause={() => onPlayStateChange(false)}
        onEnded={() => onPlayStateChange(false)}
        onLoadedMetadata={(e) => {
          if (e.currentTarget.duration && Number.isFinite(e.currentTarget.duration)) {
            setActualDuration(e.currentTarget.duration);
          }
        }}
      />

      {/* Zoom & Gain Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => applyZoomAtRatio(zoom / 2, 0.5)}
            disabled={zoom <= 1}
            title="缩小波形"
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>

          <div className="flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-md">
            {ZOOM_LEVELS.filter((z) => z <= 32).map((z) => {
              const active = Math.abs(zoom - z) < 0.25;
              return (
                <button
                  key={z}
                  type="button"
                  onClick={() => applyZoomAtRatio(z, 0.5)}
                  className={`px-2 py-0.5 text-[11px] font-mono tabular-nums rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    active ? 'bg-white text-slate-900 font-semibold shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {z}x
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => applyZoomAtRatio(zoom * 2, 0.5)}
            disabled={zoom >= 64}
            title="放大波形（也可用鼠标滚轮直接缩放）"
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-40 cursor-pointer whitespace-nowrap shrink-0"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>

          {activeUtterance && (
            <button
              type="button"
              onClick={focusActiveSegment}
              title="将视野缩放到当前选中片段"
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded cursor-pointer whitespace-nowrap shrink-0"
            >
              <Focus className="w-3 h-3" />
              <span>聚焦选中段</span>
            </button>
          )}

          {zoom > 1 && (
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setViewStart(0);
              }}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded cursor-pointer whitespace-nowrap shrink-0"
            >
              <Maximize2 className="w-3 h-3" />
              <span>全览 1x</span>
            </button>
          )}
          {onCreateSegmentRange && (
            <div className="flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-md">
              <button
                type="button"
                onClick={() => setInteractionMode('scrub')}
                className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  interactionMode === 'scrub'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                点击定位
              </button>
              <button
                type="button"
                onClick={() => setInteractionMode('range')}
                title="开启后在波形上按住左键拖拽（或任意模式下按住 Shift + 拖拽），即可直接框选一段音频"
                className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  interactionMode === 'range'
                    ? 'bg-white text-blue-700 font-semibold shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {rangeActionLabel}
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <span className="font-mono tabular-nums">
            视野 {clampedViewStart.toFixed(2)}s – {viewEnd.toFixed(2)}s
          </span>
          <span aria-hidden="true">·</span>
          <div className="flex items-center gap-1">
            <span>增益</span>
            <div className="flex items-center gap-0.5 p-0.5 bg-slate-100 rounded">
              {(['auto', 1, 2, 5, 10] as const).map((g) => (
                <button
                  key={String(g)}
                  type="button"
                  onClick={() => setGainMode(g)}
                  className={`px-1.5 py-0.5 font-mono text-[11px] rounded cursor-pointer whitespace-nowrap shrink-0 ${
                    gainMode === g ? 'bg-white text-slate-900 font-semibold shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {g === 'auto' ? '自动' : `${g}x`}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Time Ruler */}
      <div className="relative h-4 w-full select-none text-[10px] font-mono tabular-nums text-slate-400 border-b border-slate-100">
        {rulerTicks.map((tk) => (
          <div
            key={tk.time}
            style={{ left: `${tk.leftPct}%` }}
            className="absolute top-0 bottom-0 flex flex-col items-start -translate-x-1/2"
          >
            <span>{tk.time.toFixed(visibleDuration < 4 ? 2 : 1)}s</span>
            <div className="w-px h-1.5 bg-slate-300 mx-auto" />
          </div>
        ))}
      </div>

      {/* Interactive Zoomable Waveform Canvas */}
      <div
        ref={trackRef}
        role="slider"
        aria-label="音频波形时间轴（滚轮缩放，拖拽定位或框选）"
        aria-valuemin={0}
        aria-valuemax={effectiveDuration}
        aria-valuenow={currentTime}
        tabIndex={0}
        onMouseDown={(e) => {
          const t = timeFromClientX(e.clientX);
          if (onCreateSegmentRange && (interactionMode === 'range' || e.shiftKey)) {
            setDragMode({ kind: 'range', anchorTime: t, currentEdgeTime: t });
          } else {
            setDragMode({ kind: 'scrub' });
            onSeek(t);
          }
        }}
        onMouseMove={(e) => {
          const el = trackRef.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          setHoverX(e.clientX - rect.left);
          setHoverTime(timeFromClientX(e.clientX));
        }}
        onMouseLeave={() => {
          setHoverX(null);
          setHoverTime(null);
        }}
        className="relative h-[104px] w-full bg-slate-50 border border-slate-200 rounded-md overflow-hidden cursor-crosshair select-none"
      >
        {/* High-res Waveform Canvas */}
        <canvas ref={canvasRef} className="w-full h-full block pointer-events-none" />

        {/* Utterance / Vocal Segment Overlays */}
        {utterances.map((u) => {
          if (u.end < clampedViewStart || u.start > viewEnd) return null;
          const visLeft = Math.max(0, ((u.start - clampedViewStart) / visibleDuration) * 100);
          const visRight = Math.min(100, ((u.end - clampedViewStart) / visibleDuration) * 100);
          const widthPct = Math.max(0.4, visRight - visLeft);
          const isActive = u.utterance_id === activeUtteranceId;
          const isAssistant = u.role.toLowerCase() === 'assistant';

          return (
            <div
              key={u.utterance_id}
              onMouseDown={(e) => {
                if (onCreateSegmentRange && (interactionMode === 'range' || e.shiftKey)) {
                  return;
                }
                e.stopPropagation();
              }}
              onClick={(e) => {
                if (onCreateSegmentRange && (interactionMode === 'range' || e.shiftKey)) {
                  return;
                }
                e.stopPropagation();
                onSelectUtterance(u.utterance_id);
                onSeek(u.start);
              }}
              title={`#${u.utterance_id} ${u.text || u.role} (${u.start.toFixed(2)}s - ${u.end.toFixed(2)}s)`}
              style={{ left: `${visLeft}%`, width: `${widthPct}%` }}
              className={`absolute top-0 bottom-0 transition-colors border-x ${
                isActive
                  ? 'bg-blue-500/15 border-blue-600 z-10'
                  : isAssistant
                    ? 'bg-emerald-500/10 border-emerald-400/60 hover:bg-emerald-500/18'
                    : 'bg-amber-500/10 border-amber-400/60 hover:bg-amber-500/18'
              }`}
            >
              <span
                className={`absolute top-1 left-1.5 text-[10px] font-mono tabular-nums leading-none px-1 py-0.5 rounded pointer-events-none ${
                  isActive ? 'bg-blue-700 text-white' : 'text-slate-700 bg-white/85'
                }`}
              >
                #{u.utterance_id}
              </span>

              {/* Draggable Start / End edge handles when bound updater is provided */}
              {onUpdateUtteranceBounds && (
                <>
                  <div
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      onSelectUtterance(u.utterance_id);
                      setDragMode({ kind: 'handle', utteranceId: u.utterance_id, edge: 'start' });
                    }}
                    title="左右拖拽调整开始时间"
                    className="absolute left-0 top-0 bottom-0 w-2 -translate-x-1/2 cursor-ew-resize hover:bg-blue-600/40 z-20"
                  />
                  <div
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      onSelectUtterance(u.utterance_id);
                      setDragMode({ kind: 'handle', utteranceId: u.utterance_id, edge: 'end' });
                    }}
                    title="左右拖拽调整截止时间"
                    className="absolute right-0 top-0 bottom-0 w-2 translate-x-1/2 cursor-ew-resize hover:bg-blue-600/40 z-20"
                  />
                </>
              )}
            </div>
          );
        })}

        {/* Hover Hairline & Timestamp Readout */}
        {hoverX !== null && hoverTime !== null && (
          <div
            style={{ left: `${hoverX}px` }}
            className="absolute top-0 bottom-0 w-px bg-slate-400/70 pointer-events-none z-20"
          >
            <span className="absolute bottom-1 left-1 px-1 py-0.5 text-[10px] font-mono tabular-nums bg-slate-900/80 text-white rounded whitespace-nowrap">
              {hoverTime.toFixed(2)}s
            </span>
          </div>
        )}

        {/* Live drag-to-select range preview */}
        {dragMode?.kind === 'range' && (() => {
          const s = Math.min(dragMode.anchorTime, dragMode.currentEdgeTime);
          const e = Math.max(dragMode.anchorTime, dragMode.currentEdgeTime);
          const lPct = Math.max(0, ((s - clampedViewStart) / visibleDuration) * 100);
          const rPct = Math.min(100, ((e - clampedViewStart) / visibleDuration) * 100);
          return (
            <div
              style={{ left: `${lPct}%`, width: `${Math.max(0.3, rPct - lPct)}%` }}
              className="absolute top-0 bottom-0 bg-blue-600/20 border-x-2 border-blue-600 z-30 pointer-events-none"
            >
              <span className="absolute top-1 right-1 px-1.5 py-0.5 text-[10px] font-mono tabular-nums bg-blue-700 text-white rounded whitespace-nowrap">
                {s.toFixed(2)}s - {e.toFixed(2)}s ({(e - s).toFixed(2)}s)
              </span>
            </div>
          );
        })()}

        {/* Playhead */}
        {playheadInView && (
          <div
            style={{ left: `${playheadPct}%` }}
            className="absolute top-0 bottom-0 w-0.5 bg-blue-700 z-30 pointer-events-none"
          />
        )}
      </div>

      {/* Overview Minimap / Scrollbar when zoomed */}
      {zoom > 1 && (
        <div
          ref={minimapRef}
          onMouseDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const clickTime = ((e.clientX - rect.left) / rect.width) * effectiveDuration;
            const inWindow = clickTime >= clampedViewStart && clickTime <= viewEnd;
            const anchorOffsetSec = inWindow ? clickTime - clampedViewStart : visibleDuration / 2;
            const nextStart = Math.max(0, Math.min(maxViewStart, clickTime - anchorOffsetSec));
            setViewStart(nextStart);
            setDragMode({ kind: 'minimap', anchorOffsetSec });
          }}
          title="拖动高亮窗口可在放大模式下平移时间轴"
          className="relative h-4 w-full bg-slate-100 border border-slate-200 rounded cursor-grab active:cursor-grabbing select-none overflow-hidden"
        >
          {utterances.map((u) => {
            const l = (u.start / effectiveDuration) * 100;
            const w = Math.max(0.5, ((u.end - u.start) / effectiveDuration) * 100);
            return (
              <div
                key={u.utterance_id}
                style={{ left: `${l}%`, width: `${w}%` }}
                className="absolute top-1 bottom-1 bg-slate-400/40 rounded-xs pointer-events-none"
              />
            );
          })}
          <div
            style={{
              left: `${(clampedViewStart / effectiveDuration) * 100}%`,
              width: `${Math.max(2, (visibleDuration / effectiveDuration) * 100)}%`,
            }}
            className="absolute top-0 bottom-0 bg-blue-600/20 border border-blue-600 rounded-xs"
          />
          <div
            style={{ left: `${(currentTime / effectiveDuration) * 100}%` }}
            className="absolute top-0 bottom-0 w-0.5 bg-blue-700 pointer-events-none"
          />
        </div>
      )}

      {/* Transport Controls */}
      <div className="pt-0.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={togglePlay}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-blue-700 text-white rounded-md hover:bg-blue-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            <span>{isPlaying ? '暂停' : '播放音频'}</span>
          </button>

          <button
            type="button"
            onClick={() => onSeek(Math.max(0, currentTime - 1))}
            title="后退 1 秒"
            className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <SkipBack className="w-3.5 h-3.5" />
            <span className="font-mono tabular-nums">-1s</span>
          </button>

          <button
            type="button"
            onClick={() => onSeek(Math.min(effectiveDuration, currentTime + 1))}
            title="前进 1 秒"
            className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <span className="font-mono tabular-nums">+1s</span>
            <SkipForward className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => onSeek(0)}
            title="回到起点"
            className="inline-flex items-center gap-1 px-2.5 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          {(decodeState === 'loading' || decodeState === 'error') && (
            <span role="status" className="text-[11px] text-slate-500">
              {decodeState === 'loading' ? '正在读取音频波形…' : '无法读取音频波形'}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs font-mono tabular-nums text-slate-700">
            <span className="font-semibold text-slate-900">{formatSec(currentTime)}</span>
            <span className="mx-1.5 text-slate-400">/</span>
            <span>{formatSec(effectiveDuration)}</span>
          </div>

          {zoom > 1 && (
            <button
              type="button"
              onClick={() => setFollowPlayhead((v) => !v)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                followPlayhead
                  ? 'bg-blue-50 border-blue-200 text-blue-700'
                  : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              跟随播放
            </button>
          )}

          <button
            type="button"
            onClick={onToggleLoopSegment}
            disabled={!activeUtterance}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${
              loopSegment
                ? 'bg-blue-50 border-blue-200 text-blue-700'
                : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Repeat className="w-3.5 h-3.5" />
            <span>单句循环</span>
          </button>

          <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md">
            {[0.75, 1, 1.25, 1.5].map((rate) => (
              <button
                key={rate}
                type="button"
                onClick={() => onPlaybackRateChange(rate)}
                className={`px-2 py-1 text-xs font-mono tabular-nums rounded transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  playbackRate === rate
                    ? 'bg-white text-slate-900 font-medium shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
