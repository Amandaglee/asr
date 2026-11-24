import JSZip from 'jszip';
import {
  QASessionItem,
  TranscriptSession,
  VocalAudioItem,
  VocalSegment,
  VocalSegmentType,
} from '../types/asr';
import { parseReferenceJsonInput } from './validation';

export interface ParsedBatchPreview {
  paired: Array<{
    session: TranscriptSession;
    audioFile: File;
    sourceJsonName?: string;
    matchReason: string;
  }>;
  unmatchedAudio: string[];
  unmatchedJson: Array<{ fileName: string; reason: string }>;
}

const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm', '.aac', '.mp4']);

function getExt(filePath: string): string {
  const idx = filePath.lastIndexOf('.');
  return idx >= 0 ? filePath.slice(idx).toLowerCase() : '';
}

function getBaseName(filePath: string): string {
  const slashIdx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const fileName = slashIdx >= 0 ? filePath.slice(slashIdx + 1) : filePath;
  const dotIdx = fileName.lastIndexOf('.');
  return (dotIdx >= 0 ? fileName.slice(0, dotIdx) : fileName).trim();
}

function getFileNameOnly(filePath: string): string {
  const slashIdx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return slashIdx >= 0 ? filePath.slice(slashIdx + 1) : filePath;
}

function guessAudioMimeType(fileName: string): string {
  switch (getExt(fileName)) {
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mp3';
    case '.m4a':
    case '.mp4':
      return 'audio/mp4';
    case '.ogg':
      return 'audio/ogg';
    case '.flac':
      return 'audio/flac';
    case '.aac':
      return 'audio/aac';
    case '.webm':
      return 'audio/webm';
    default:
      return 'audio/wav';
  }
}

function isMacJunkPath(entryPath: string): boolean {
  const name = getFileNameOnly(entryPath);
  return entryPath.includes('__MACOSX/') || name.startsWith('._') || name === '.DS_Store';
}

interface ExtractedJsonCandidate {
  sourceFile: string;
  baseName: string;
  audioHint?: string;
  session: TranscriptSession;
}

function extractSessionsFromJsonText(
  rawText: string,
  fileName: string
): { items: ExtractedJsonCandidate[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return {
      items: [],
      error: err instanceof Error ? `JSON 解析错误: ${err.message}` : 'JSON 格式错误',
    };
  }

  const baseName = getBaseName(fileName);

  // Case 1: Array of session objects OR raw array of utterances
  if (Array.isArray(parsed)) {
    const firstItem = parsed[0] as Record<string, unknown> | undefined;
    if (
      firstItem &&
      typeof firstItem === 'object' &&
      !Array.isArray(firstItem.transcripts) &&
      (typeof firstItem.text === 'string' || typeof firstItem.utterance_id === 'number')
    ) {
      const { session } = parseReferenceJsonInput(rawText);
      if (session) {
        return {
          items: [
            {
              sourceFile: fileName,
              baseName,
              session: {
                ...session,
                session_id: baseName || session.session_id,
              },
            },
          ],
        };
      }
    }

    const items: ExtractedJsonCandidate[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === 'object') {
        const rec = entry as Record<string, unknown>;
        const { session } = parseReferenceJsonInput(JSON.stringify(entry));
        if (session) {
          const hint =
            typeof rec.audio_file === 'string'
              ? rec.audio_file
              : typeof rec.audio === 'string'
                ? rec.audio
                : typeof rec.file === 'string'
                  ? rec.file
                  : undefined;
          items.push({
            sourceFile: fileName,
            baseName: getBaseName(hint || session.session_id),
            audioHint: hint,
            session,
          });
        }
      }
    }
    if (items.length > 0) return { items };
    return { items: [], error: '数组中未找到有效的 session_id / transcripts 结构' };
  }

  // Case 2: Wrapper object { sessions: [...] } or { items: [...] } or { results: [...] }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const listCandidate =
      Array.isArray(obj.sessions)
        ? obj.sessions
        : Array.isArray(obj.items)
          ? obj.items
          : Array.isArray(obj.results) && obj.results.length > 1
            ? obj.results
            : null;

    if (listCandidate) {
      const items: ExtractedJsonCandidate[] = [];
      for (const entry of listCandidate) {
        if (entry && typeof entry === 'object') {
          const rec = entry as Record<string, unknown>;
          const { session } = parseReferenceJsonInput(JSON.stringify(entry));
          if (session) {
            const hint =
              typeof rec.audio_file === 'string'
                ? rec.audio_file
                : typeof rec.audio === 'string'
                  ? rec.audio
                  : undefined;
            items.push({
              sourceFile: fileName,
              baseName: getBaseName(hint || session.session_id),
              audioHint: hint,
              session,
            });
          }
        }
      }
      if (items.length > 0) return { items };
    }
  }

  // Case 3: Single session JSON
  const { session, error } = parseReferenceJsonInput(rawText);
  if (session) {
    const rec = parsed as Record<string, unknown>;
    const hint =
      typeof rec.audio_file === 'string'
        ? rec.audio_file
        : typeof rec.audio === 'string'
          ? rec.audio
          : undefined;
    return {
      items: [
        {
          sourceFile: fileName,
          baseName,
          audioHint: hint,
          session,
        },
      ],
    };
  }

  return { items: [], error: error || '不符合参考 JSON 格式' };
}

async function probeAudioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      resolve(null);
    }, 2500);

    audio.addEventListener('loadedmetadata', () => {
      clearTimeout(timer);
      const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? Number(audio.duration.toFixed(2)) : null;
      URL.revokeObjectURL(url);
      resolve(dur);
    });
    audio.addEventListener('error', () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(null);
    });
  });
}

export async function parseFilesOrZipForBatch(inputFiles: File[]): Promise<ParsedBatchPreview> {
  const audioFiles: File[] = [];
  const jsonEntries: Array<{ fileName: string; text: string }> = [];

  for (const file of inputFiles) {
    if (isMacJunkPath(file.name)) continue;
    const ext = getExt(file.name);

    if (ext === '.zip' || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entries = Object.values(zip.files);

      for (const entry of entries) {
        if (entry.dir || isMacJunkPath(entry.name)) continue;
        const entryExt = getExt(entry.name);
        const cleanName = getFileNameOnly(entry.name);

        if (AUDIO_EXTENSIONS.has(entryExt)) {
          const blob = await entry.async('blob');
          const mime = guessAudioMimeType(cleanName);
          audioFiles.push(new File([blob], cleanName, { type: mime }));
        } else if (entryExt === '.json') {
          const text = await entry.async('string');
          jsonEntries.push({ fileName: cleanName, text });
        }
      }
    } else if (AUDIO_EXTENSIONS.has(ext) || file.type.startsWith('audio/')) {
      audioFiles.push(file);
    } else if (ext === '.json' || file.type === 'application/json') {
      jsonEntries.push({ fileName: file.name, text: await file.text() });
    }
  }

  // Extract all JSON candidates
  const candidates: ExtractedJsonCandidate[] = [];
  const unmatchedJson: Array<{ fileName: string; reason: string }> = [];

  for (const j of jsonEntries) {
    const { items, error } = extractSessionsFromJsonText(j.text, j.fileName);
    if (items.length === 0) {
      unmatchedJson.push({ fileName: j.fileName, reason: error || '未识别有效结构' });
    } else {
      candidates.push(...items);
    }
  }

  // Pair audio files with JSON candidates
  const usedAudioIndices = new Set<number>();
  const paired: ParsedBatchPreview['paired'] = [];

  for (const cand of candidates) {
    let matchedIdx = -1;
    let matchReason = '';

    // 1. Match by explicit audio_file hint
    if (cand.audioHint) {
      const hintBase = getBaseName(cand.audioHint).toLowerCase();
      const hintFull = getFileNameOnly(cand.audioHint).toLowerCase();
      matchedIdx = audioFiles.findIndex(
        (f, idx) =>
          !usedAudioIndices.has(idx) &&
          (f.name.toLowerCase() === hintFull || getBaseName(f.name).toLowerCase() === hintBase)
      );
      if (matchedIdx >= 0) matchReason = 'audio_file 字段匹配';
    }

    // 2. Match by JSON filename base == audio filename base
    if (matchedIdx < 0) {
      const targetBase = cand.baseName.toLowerCase();
      matchedIdx = audioFiles.findIndex(
        (f, idx) => !usedAudioIndices.has(idx) && getBaseName(f.name).toLowerCase() === targetBase
      );
      if (matchedIdx >= 0) matchReason = '同名文件配对';
    }

    // 3. Match by session_id == audio filename base
    if (matchedIdx < 0) {
      const sidBase = cand.session.session_id.trim().toLowerCase();
      matchedIdx = audioFiles.findIndex(
        (f, idx) => !usedAudioIndices.has(idx) && getBaseName(f.name).toLowerCase() === sidBase
      );
      if (matchedIdx >= 0) matchReason = 'session_id 配对';
    }

    if (matchedIdx >= 0) {
      usedAudioIndices.add(matchedIdx);
      const audioFile = audioFiles[matchedIdx];
      let finalSession = cand.session;
      if (!finalSession.duration_sec || finalSession.duration_sec <= 0) {
        const probed = await probeAudioDuration(audioFile);
        if (probed) {
          finalSession = { ...finalSession, duration_sec: probed };
        }
      }
      const sameSourceCount = candidates.filter((c) => c.sourceFile === cand.sourceFile).length;
      const sourceJsonName =
        sameSourceCount === 1
          ? cand.sourceFile
          : `${getBaseName(audioFile.name) || finalSession.session_id}.json`;
      paired.push({ session: finalSession, audioFile, sourceJsonName, matchReason });
    } else {
      unmatchedJson.push({
        fileName: `${cand.sourceFile} (${cand.session.session_id})`,
        reason: '未找到同名或对应 session_id 的音频文件',
      });
    }
  }

  const unmatchedAudio = audioFiles
    .filter((_, idx) => !usedAudioIndices.has(idx))
    .map((f) => f.name);

  return { paired, unmatchedAudio, unmatchedJson };
}

export function createQASessionItems(paired: ParsedBatchPreview['paired']): QASessionItem[] {
  const now = Date.now();
  return paired.map((item, idx) => ({
    id: `${item.session.session_id}-${now}-${idx}`,
    audioName: item.audioFile.name,
    sourceJsonName: item.sourceJsonName,
    audioMimeType: item.audioFile.type || guessAudioMimeType(item.audioFile.name),
    audioSize: item.audioFile.size,
    audioUrl: URL.createObjectURL(item.audioFile),
    audioFile: item.audioFile,
    referenceJson: item.session,
    jobState: 'pending',
    lastUpdatedAt: now,
  }));
}

const VOCAL_NAME_PATTERNS: Array<{ type: VocalSegmentType; regex: RegExp }> = [
  { type: '耳语_人声段', regex: /耳语|whisper|eryu|er_yu|er-yu/i },
  { type: '气声_人声段', regex: /气声|气息|breathy|breath|qisheng|qi_sheng|qi-sheng/i },
  { type: '正常_人声段', regex: /正常|normal|modal|zhengchang|zheng_chang|zheng-chang/i },
];

function matchVocalTypesInText(text: string): VocalSegmentType[] {
  if (!text) return [];
  const hits: Array<{ type: VocalSegmentType; index: number }> = [];
  for (const p of VOCAL_NAME_PATTERNS) {
    const m = p.regex.exec(text);
    if (m) {
      hits.push({ type: p.type, index: m.index });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((h) => h.type);
}

export function inferVocalTypesFromFileName(
  fileName: string,
  relativePath?: string
): VocalSegmentType[] {
  const fromName = matchVocalTypesInText(fileName);
  if (fromName.length > 0) return fromName;
  if (relativePath) {
    return matchVocalTypesInText(relativePath);
  }
  return [];
}

export async function extractAudioFilesForVocalImport(inputFiles: File[]): Promise<VocalAudioItem[]> {
  const audioEntries: Array<{ file: File; relativePath: string }> = [];

  for (const file of inputFiles) {
    if (isMacJunkPath(file.name)) continue;
    const ext = getExt(file.name);

    if (ext === '.zip' || file.type === 'application/zip' || file.type === 'application/x-zip-compressed') {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entries = Object.values(zip.files);

      for (const entry of entries) {
        if (entry.dir || isMacJunkPath(entry.name)) continue;
        const entryExt = getExt(entry.name);
        const cleanName = getFileNameOnly(entry.name);
        if (AUDIO_EXTENSIONS.has(entryExt)) {
          const blob = await entry.async('blob');
          const mime = guessAudioMimeType(cleanName);
          audioEntries.push({
            file: new File([blob], cleanName, { type: mime }),
            relativePath: entry.name,
          });
        }
      }
    } else if (AUDIO_EXTENSIONS.has(ext) || file.type.startsWith('audio/')) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      audioEntries.push({ file, relativePath: rel });
    }
  }

  const now = Date.now();
  const items = await Promise.all(
    audioEntries.map(async ({ file, relativePath }, idx) => {
      const probed = await probeAudioDuration(file);
      const queryId = getBaseName(file.name) || `query_${idx + 1}`;
      const audioUrl = URL.createObjectURL(file);
      const matchedTypes = inferVocalTypesFromFileName(file.name, relativePath);

      let durationSec = probed ?? 0;
      let segStart = 0;
      let segEnd = durationSec;

      if (matchedTypes.length > 0 && file.size <= 25 * 1024 * 1024) {
        const bounds = await detectAudioSpeechBounds(audioUrl, durationSec);
        if (bounds) {
          durationSec = durationSec > 0 ? durationSec : bounds.totalDuration;
          segStart = bounds.start;
          segEnd = bounds.end;
        }
      }

      const segments: VocalSegment[] = [];
      if (matchedTypes.length > 0) {
        const safeEnd = segEnd > segStart ? segEnd : Math.max(segStart + 0.5, durationSec || 1);
        const span = safeEnd - segStart;
        const sliceDur = span / matchedTypes.length;
        matchedTypes.forEach((vt, tIdx) => {
          const s = Number((segStart + tIdx * sliceDur).toFixed(2));
          const e = Number((segStart + (tIdx + 1) * sliceDur).toFixed(2));
          segments.push({
            id: `seg-${now}-${idx}-${tIdx}`,
            type: vt,
            start: s,
            end: Math.max(Number((s + 0.05).toFixed(2)), e),
            spokenCue: '文件名自动识别',
          });
        });
      }

      return {
        id: `vocal-${queryId}-${now}-${idx}`,
        queryId,
        audioName: file.name,
        audioMimeType: file.type || guessAudioMimeType(file.name),
        audioSize: file.size,
        audioUrl,
        audioFile: file,
        durationSec,
        detectedTypeFromName: matchedTypes[0],
        segments,
        confirmed: false,
        jobState: 'pending' as const,
      };
    })
  );

  return items;
}

export async function detectAudioSpeechBounds(
  audioUrl: string,
  fallbackDurationSec: number,
  windowStartSec?: number,
  windowEndSec?: number
): Promise<{ start: number; end: number; totalDuration: number } | null> {
  try {
    const res = await fetch(audioUrl);
    const arrayBuf = await res.arrayBuffer();
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      const decoded = await ctx.decodeAudioData(arrayBuf);
      const totalDuration = Number((decoded.duration || fallbackDurationSec).toFixed(2));
      const data = decoded.getChannelData(0);
      const sampleRate = decoded.sampleRate;
      const frameSamples = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms frames

      const minSec = windowStartSec !== undefined ? Math.max(0, windowStartSec) : 0;
      const maxSec =
        windowEndSec !== undefined ? Math.min(totalDuration, windowEndSec) : totalDuration;
      const startSample = Math.floor(minSec * sampleRate);
      const endSample = Math.min(data.length, Math.ceil(maxSec * sampleRate));

      const frameRms: Array<{ timeStart: number; timeEnd: number; rms: number }> = [];
      let peakRms = 0;

      for (let i = startSample; i < endSample; i += frameSamples) {
        const stop = Math.min(endSample, i + frameSamples);
        let sumSq = 0;
        for (let j = i; j < stop; j++) {
          sumSq += data[j] * data[j];
        }
        const rms = Math.sqrt(sumSq / Math.max(1, stop - i));
        if (rms > peakRms) peakRms = rms;
        frameRms.push({
          timeStart: i / sampleRate,
          timeEnd: stop / sampleRate,
          rms,
        });
      }

      if (frameRms.length === 0 || peakRms < 0.002) {
        return {
          start: Number(minSec.toFixed(2)),
          end: Number(maxSec.toFixed(2)),
          totalDuration,
        };
      }

      const threshold = Math.max(0.004, peakRms * 0.08);
      const firstActive = frameRms.findIndex((f) => f.rms >= threshold);
      let lastActive = -1;
      for (let i = frameRms.length - 1; i >= 0; i--) {
        if (frameRms[i].rms >= threshold) {
          lastActive = i;
          break;
        }
      }

      if (firstActive < 0 || lastActive < 0) {
        return {
          start: Number(minSec.toFixed(2)),
          end: Number(maxSec.toFixed(2)),
          totalDuration,
        };
      }

      const onset = Math.max(minSec, frameRms[firstActive].timeStart - 0.04);
      const offset = Math.min(maxSec, frameRms[lastActive].timeEnd + 0.04);
      return {
        start: Number(onset.toFixed(2)),
        end: Number(Math.max(onset + 0.05, offset).toFixed(2)),
        totalDuration,
      };
    } finally {
      ctx.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

