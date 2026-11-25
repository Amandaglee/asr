import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import type { Server } from 'http';
import os from 'os';
import path from 'path';
import multer from 'multer';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';
const serverHost = process.env.ASR_DESKTOP === 'true' ? '127.0.0.1' : '0.0.0.0';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  apiVersion: 'v1beta',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

const aiAlpha = ai;

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('429');
      if (!isTransient || attempt === retries - 1) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 900 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024, // 30 MB per chunk / direct request
  },
});

interface ChunkUploadSession {
  uploadId: string;
  fileName: string;
  mimeType: string;
  totalChunks: number;
  receivedChunks: Set<number>;
  tempFilePath: string;
  createdAt: number;
}

interface CalibrationJobState {
  jobId: string;
  status: 'queued' | 'uploading' | 'processing_audio' | 'calibrating' | 'completed' | 'error';
  progressText: string;
  result?: unknown;
  error?: string;
  createdAt: number;
}

type HistoryKind = 'qa' | 'vocal';

interface LocalHistoryRecord {
  id: string;
  kind: HistoryKind;
  audioFileName: string;
  audioMimeType: string;
  audioSize: number;
  createdAt: number;
  updatedAt: number;
  data: Record<string, unknown>;
}

const chunkUploads = new Map<string, ChunkUploadSession>();
const calibrationJobs = new Map<string, CalibrationJobState>();
const localDataRoot =
  process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const legacyHistoryRoot = path.join(
  localDataRoot,
  'ASR语音转写质检与校准工作台',
  '作业历史'
);
const historyRoot = path.resolve(
  process.env.ASR_HISTORY_DIR ||
    path.join(localDataRoot, 'ASR-Workbench', 'Job-History')
);

async function ensureHistoryRoot(): Promise<void> {
  if (!process.env.ASR_HISTORY_DIR && historyRoot !== legacyHistoryRoot) {
    try {
      await fs.promises.access(historyRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await fs.promises.access(legacyHistoryRoot);
        await fs.promises.cp(legacyHistoryRoot, historyRoot, { recursive: true, errorOnExist: true });
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code !== 'ENOENT') throw copyError;
      }
    }
  }
  await fs.promises.mkdir(historyRoot, { recursive: true });
}

function isLocalRequest(req: express.Request): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

function requireLocalRequest(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  if (!isLocalRequest(req)) {
    res.status(403).json({ error: '本地作业历史只允许本机访问。' });
    return;
  }
  next();
}

function historyRecordPath(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('作业记录编号无效。');
  }
  return path.join(historyRoot, id, 'record.json');
}

async function writeHistoryRecord(record: LocalHistoryRecord): Promise<void> {
  const recordPath = historyRecordPath(record.id);
  const tempPath = `${recordPath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(tempPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(tempPath, recordPath);
}

async function removeUploadFiles(session: ChunkUploadSession): Promise<void> {
  const paths = [
    session.tempFilePath,
    ...Array.from({ length: session.totalChunks }, (_, index) => `${session.tempFilePath}.part.${index}`),
  ];
  await Promise.all(
    paths.map(async (filePath) => {
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    })
  );
}

const BASE_SYSTEM_INSTRUCTION = `你是一名极其严谨的语音转写（ASR）质检与校准专家。你的唯一任务是：以真实音频的每一帧声音为绝对标准，逐条核对并修正输入的参考 JSON 转写数据。

### 一、 核心校准原则（零容错）
1. 绝对忠于音频原声（所听即所得）：音频里实际发出什么声音，JSON 就原封不动保留什么字词，严禁进行书面化润色、语法纠错、流畅化改写或脑补。
2. 字词精修与口误完整保留（最高优先级）：
   - 错别字/同音字修正：仔细辨音并修正同音错字或近音误识别。
   - 漏字/吞字补全：补全漏识别的实词、短语或时间节点。
   - 真实口语与语气词还原：音频中实际发出的叹词、语气助词（如 哎哟、诶、欸、嗯、呢、啊、一丢丢 等）必须如实保留或补全；若原 JSON 误识别了不存在的词，必须删除或纠正。
   - 口误、口吃、改口与打断必须一并保留（严禁替说话人删掉口误！）：例如说话人先口误说出“整个”紧接着马上改口说成“穿个”，必须如实转写保留为“整个，穿个……”或“整个穿个……”（音频发了哪些音就全部保留，绝不可删掉口误“整个”只留“穿个”）；若原 JSON 漏掉了真实说出的口误或重复（如“等一下等一下”、“就是、就是”），必须补全回来；被对方抢话打断的未完句也不得擅自补全未说出口的后半句。
3. 说话人角色（role）核对：
   - 严格核对每条 utterance_id 的 role，role 必须严格从输入 JSON 中实际出现或规则约定的角色集合中选取（例如 user、assistant、test 等，严禁擅自把自定义角色改写为 assistant）；一旦发现声纹与角色不匹配，必须立即修正。
4. 时间轴（start / end）保护原则（严禁顺延篡改）：
   - 输入的参考 JSON 时间轴通常由精准的语音活动检测（VAD）切分生成，大部分原本就是准确的。
   - 绝对禁止任何形式的“连锁顺延”或“整体平移”后续语句时间戳！
   - 默认严格保持原 start 与 end 数值不变；仅在明确开启“独立微调”模式且某单句起止时间存在明显严重错位（偏差 > 0.5s）时，才允许仅针对该孤立语句微调，严禁波及前后其他语句，且必须保证 0 <= start < end <= duration_sec。

### 二、 批量处理与防省略约束
- 必须独立、完整地输出全部 transcripts 数组，**输入有多少条 utterance_id，就必须一对一完整输出多少条**。
- **严禁删除、跳过或合并任何一条 utterance_id**（即使中间有连续几十条，也绝不可遗漏任何编号）。
- 严禁使用任何形式的省略占位符，即使某条 JSON 完全没错，也必须原样完整返回。
- 严格保持输入 JSON 的字段命名、数据类型与嵌套层级不变，仅修改存在问题的字段值。

### 三、 输出格式规范
请严格按照指定的 JSON Schema 输出唯一合法的 JSON 对象，不要包含多余解释文字。`;

const CALIBRATION_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          session_id: { type: Type.STRING },
          status: { type: Type.STRING, description: '必须是 "完全没错" 或 "已修正"' },
          summary: {
            type: Type.STRING,
            description: '简明扼要列出修改了哪几条 utterance_id 及具体改动原因；若完全没错则填 "无修改"',
          },
          corrected_json: {
            type: Type.OBJECT,
            properties: {
              session_id: { type: Type.STRING },
              duration_sec: { type: Type.NUMBER },
              transcripts: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    utterance_id: { type: Type.INTEGER },
                    role: { type: Type.STRING },
                    start: { type: Type.NUMBER },
                    end: { type: Type.NUMBER },
                    text: { type: Type.STRING },
                  },
                  required: ['utterance_id', 'role', 'start', 'end', 'text'],
                },
              },
            },
            required: ['session_id', 'duration_sec', 'transcripts'],
          },
        },
        required: ['session_id', 'status', 'summary', 'corrected_json'],
      },
    },
  },
  required: ['results'],
};

const VOCAL_DETECT_SYSTEM_INSTRUCTION = `你是一名专业的语音声学与人声类型标注专家。你的任务是根据真实音频内容，精准识别音频中包含的人声段类型及其开始时间（start）和截止时间（end）。

人声段类型严格限定为以下三种：
1. "正常_人声段"：正常说话声（音频中可能会口头说明“正常”、“正常人声”、“正常声音”或使用自然正常嗓音说话）。
2. "耳语_人声段"：耳语/悄悄话（音频中可能会口头说明“耳语”、“悄悄话”或使用无声带振动的轻声耳语发声）。
3. "气声_人声段"：气声（音频中可能会口头说明“气声”、“气息声”或带有明显气流声的气声发声）。

标注规则：
- 仔细聆听音频内容：音频里通常已经口头说明了是什么类型的人声段（例如“正常……”、“耳语……”、“气声……”），同时结合音色特征，将其准确归类为上述三种类型之一。
- 精准定位每一段人声的真实发声开始时间（start，秒）与截止时间（end，秒），排除前后明显的空白静音，精确到小数点后两位。
- 若一段音频中连续或分段出现多种类型人声（例如先说正常段、再说耳语段、再说气声段），请按时间顺序逐段分别列出；若只有一种人声段，则输出对应的一段。
- 严格满足 0 <= start < end <= 音频总时长。`;

const VOCAL_DETECT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          vocal_type: {
            type: Type.STRING,
            description: '必须是 "正常_人声段"、"耳语_人声段" 或 "气声_人声段" 之一',
          },
          start: { type: Type.NUMBER, description: '开始时间（秒，保留2位小数）' },
          end: { type: Type.NUMBER, description: '截止时间（秒，保留2位小数）' },
          spoken_cue: { type: Type.STRING, description: '识别到的说话内容或口述类型词' },
        },
        required: ['vocal_type', 'start', 'end', 'spoken_cue'],
      },
    },
  },
  required: ['segments'],
};

function normalizeAudioMimeType(mimeType: string, originalName: string): string {
  const lower = (mimeType || '').toLowerCase();
  if (lower && lower !== 'application/octet-stream') {
    if (lower === 'audio/wave' || lower === 'audio/x-wav') return 'audio/wav';
    if (lower === 'audio/x-m4a') return 'audio/mp4';
    return lower;
  }
  const ext = path.extname(originalName || '').toLowerCase();
  switch (ext) {
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

function getWavDurationSeconds(wavBuffer: Buffer): number {
  if (wavBuffer.length >= 44 && wavBuffer.toString('ascii', 0, 4) === 'RIFF') {
    const sampleRate = wavBuffer.readUInt32LE(24) || 24000;
    const channels = wavBuffer.readUInt16LE(22) || 1;
    const bitsPerSample = wavBuffer.readUInt16LE(34) || 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);

    // Find 'data' subchunk
    let offset = 12;
    while (offset + 8 <= wavBuffer.length) {
      const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
      const chunkSize = wavBuffer.readUInt32LE(offset + 4);
      if (chunkId === 'data' && byteRate > 0) {
        return Number((chunkSize / byteRate).toFixed(2));
      }
      offset += 8 + chunkSize;
    }
    if (byteRate > 0) {
      return Number(((wavBuffer.length - 44) / byteRate).toFixed(2));
    }
  }
  return Number((wavBuffer.length / 48000).toFixed(2));
}

function formatGeminiError(err: unknown): { status: number; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('API_KEY_INVALID') || msg.includes('PERMISSION_DENIED') || msg.includes('403')) {
    return {
      status: 403,
      message: 'Gemini API 密钥无效或未配置，请在 Settings > Secrets 中检查 GEMINI_API_KEY。',
    };
  }
  if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message: 'Gemini API 配额已达上限 (429 RESOURCE_EXHAUSTED)，请稍后重试或检查结算配额。',
    };
  }
  if (msg.includes('404') || msg.includes('NOT_FOUND')) {
    return {
      status: 404,
      message: `请求的模型或资源不可用：${msg}`,
    };
  }
  return {
    status: 500,
    message: `校准请求处理失败：${msg}`,
  };
}

export async function startServer(port = PORT): Promise<Server> {
  const app = express();
  app.post(
    ['/api/calibrate', '/api/calibrate-start', '/api/vocal-detect', '/api/vocal-detect-start', '/api/demo-sample'],
    (_req, res, next) => {
      if (!process.env.GEMINI_API_KEY?.trim() && !process.env.GOOGLE_API_KEY?.trim()) {
        res.status(403).json({ error: '此功能需要 Gemini API 密钥。请配置密钥后再试。' });
        return;
      }
      next();
    }
  );
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/history', requireLocalRequest, async (_req, res, next) => {
    try {
      await ensureHistoryRoot();
      const entries = await fs.promises.readdir(historyRoot, { withFileTypes: true });
      const records: LocalHistoryRecord[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const recordPath = historyRecordPath(entry.name);
        const record = JSON.parse(await fs.promises.readFile(recordPath, 'utf8')) as LocalHistoryRecord;
        records.push(record);
      }
      records.sort((a, b) => b.updatedAt - a.updatedAt);
      res.json({
        storagePath: historyRoot,
        records: records.map((record) => ({
          ...record,
          audioUrl: `/api/history/${encodeURIComponent(record.id)}/audio`,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/history', requireLocalRequest, async (req, res, next) => {
    let createdDirectory: string | null = null;
    try {
      const { uploadId, kind, data } = req.body ?? {};
      if (kind !== 'qa' && kind !== 'vocal') {
        res.status(400).json({ error: '作业类型无效。' });
        return;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        res.status(400).json({ error: '作业记录数据无效。' });
        return;
      }
      const uploadSession = chunkUploads.get(String(uploadId || ''));
      if (!uploadSession) {
        res.status(404).json({ error: '音频上传会话不存在，请重新保存。' });
        return;
      }
      if (uploadSession.receivedChunks.size !== uploadSession.totalChunks) {
        res.status(400).json({
          error: `音频分片未上传完整 (${uploadSession.receivedChunks.size}/${uploadSession.totalChunks})。`,
        });
        return;
      }

      const id = crypto.randomUUID();
      const recordDirectory = path.join(historyRoot, id);
      const extension = path.extname(uploadSession.fileName).toLowerCase();
      const audioFileName = `audio${/^\.[a-z0-9]{1,10}$/i.test(extension) ? extension : '.bin'}`;
      const audioPath = path.join(recordDirectory, audioFileName);
      await ensureHistoryRoot();
      await fs.promises.mkdir(recordDirectory, { recursive: true });
      createdDirectory = recordDirectory;

      const output = await fs.promises.open(audioPath, 'w');
      try {
        for (let index = 0; index < uploadSession.totalChunks; index++) {
          const partPath = `${uploadSession.tempFilePath}.part.${index}`;
          const part = await fs.promises.readFile(partPath);
          await output.write(part);
        }
      } finally {
        await output.close();
      }

      const stat = await fs.promises.stat(audioPath);
      await removeUploadFiles(uploadSession);
      const record: LocalHistoryRecord = {
        id,
        kind,
        audioFileName,
        audioMimeType: uploadSession.mimeType,
        audioSize: stat.size,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        data: { ...data, id, audioName: uploadSession.fileName, audioMimeType: uploadSession.mimeType, audioSize: stat.size },
      };
      await writeHistoryRecord(record);
      chunkUploads.delete(uploadSession.uploadId);
      res.status(201).json({
        id,
        audioUrl: `/api/history/${encodeURIComponent(id)}/audio`,
      });
    } catch (error) {
      if (createdDirectory) {
        await fs.promises.rm(createdDirectory, { recursive: true, force: true });
      }
      next(error);
    }
  });

  app.put('/api/history/:id', requireLocalRequest, async (req, res, next) => {
    try {
      const recordPath = historyRecordPath(req.params.id);
      const current = JSON.parse(await fs.promises.readFile(recordPath, 'utf8')) as LocalHistoryRecord;
      const { data } = req.body ?? {};
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        res.status(400).json({ error: '作业记录数据无效。' });
        return;
      }
      const updated: LocalHistoryRecord = {
        ...current,
        data: { ...data, id: current.id },
        updatedAt: Date.now(),
      };
      await writeHistoryRecord(updated);
      res.json({ ok: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: '本地作业记录不存在；请检查是否已手动删除。' });
        return;
      }
      next(error);
    }
  });

  app.get('/api/history/:id/audio', requireLocalRequest, async (req, res, next) => {
    try {
      const recordPath = historyRecordPath(req.params.id);
      const record = JSON.parse(await fs.promises.readFile(recordPath, 'utf8')) as LocalHistoryRecord;
      if (!/^audio\.[a-z0-9]{1,10}$/i.test(record.audioFileName)) {
        res.status(400).json({ error: '本地记录中的音频文件名无效。' });
        return;
      }
      const audioPath = path.join(path.dirname(recordPath), record.audioFileName);
      res.type(record.audioMimeType);
      res.sendFile(audioPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: '本地作业记录或音频文件不存在。' });
        return;
      }
      next(error);
    }
  });

  app.delete('/api/upload/:uploadId', requireLocalRequest, async (req, res, next) => {
    const uploadSession = chunkUploads.get(req.params.uploadId);
    if (!uploadSession) {
      res.status(404).json({ error: '上传会话不存在或已清理。' });
      return;
    }
    try {
      await removeUploadFiles(uploadSession);
      chunkUploads.delete(uploadSession.uploadId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  interface TranscriptUtterance {
    utterance_id: number;
    role: string;
    start: number;
    end: number;
    text: string;
    [key: string]: unknown;
  }

  type VocalTypeLabel = '正常_人声段' | '耳语_人声段' | '气声_人声段';

  function normalizeVocalType(raw: string): VocalTypeLabel {
    const s = (raw || '').trim();
    if (s.includes('耳语') || s.toLowerCase().includes('whisper')) return '耳语_人声段';
    if (s.includes('气声') || s.toLowerCase().includes('breath')) return '气声_人声段';
    return '正常_人声段';
  }

  async function executeVocalDetectionFromFile(params: {
    filePath?: string;
    fileBuffer?: Buffer;
    fileSize: number;
    originalName: string;
    mimeType: string;
    durationSec?: number;
    onStage?: (status: CalibrationJobState['status'], text: string) => void;
  }) {
    let tempFilePathToClean: string | null = params.filePath ?? null;
    let uploadedFileName: string | null = null;

    try {
      const mimeType = normalizeAudioMimeType(params.mimeType, params.originalName);
      let audioPart:
        | { inlineData: { mimeType: string; data: string } }
        | { fileData: { mimeType: string; fileUri: string } };

      if (params.fileSize <= 14 * 1024 * 1024) {
        const buf =
          params.fileBuffer ??
          (tempFilePathToClean ? await fs.promises.readFile(tempFilePathToClean) : null);
        if (!buf) {
          throw new Error('服务端未找到音频数据');
        }
        params.onStage?.('calibrating', 'AI 正在识别人声段类型与起止时间...');
        audioPart = {
          inlineData: {
            mimeType,
            data: buf.toString('base64'),
          },
        };
      } else {
        if (!tempFilePathToClean && params.fileBuffer) {
          const ext = path.extname(params.originalName || '') || '.wav';
          tempFilePathToClean = path.join(os.tmpdir(), `asr-vocal-${Date.now()}${ext}`);
          await fs.promises.writeFile(tempFilePathToClean, params.fileBuffer);
        }
        if (!tempFilePathToClean) {
          throw new Error('服务端未找到音频临时文件');
        }

        params.onStage?.('uploading', '正在将音频上传至 Gemini 文件服务...');
        const uploaded = await withRetry(() =>
          ai.files.upload({
            file: tempFilePathToClean!,
            config: { mimeType },
          })
        );
        uploadedFileName = uploaded.name ?? null;

        let activeFile = uploaded;
        let waitAttempts = 0;
        while (activeFile.state === 'PROCESSING' && uploadedFileName && waitAttempts < 90) {
          params.onStage?.('processing_audio', 'Gemini 正在解析音频...');
          await new Promise((r) => setTimeout(r, 2000));
          activeFile = await ai.files.get({ name: uploadedFileName });
          waitAttempts++;
        }
        if (activeFile.state === 'FAILED') {
          throw new Error('Gemini 文件服务解析该音频失败，请确认音频格式是否正常。');
        }

        audioPart = {
          fileData: {
            mimeType: activeFile.mimeType ?? mimeType,
            fileUri: activeFile.uri ?? '',
          },
        };
      }

      const durHint =
        params.durationSec && params.durationSec > 0
          ? `已知该音频总时长约为 ${params.durationSec.toFixed(2)} 秒，所有起止时间必须严格落在 [0, ${params.durationSec.toFixed(2)}] 之间。`
          : '请仔细听完整段音频并确保所有起止时间合理且有序。';

      const userPrompt = `请聆听这段音频（文件名：${params.originalName}）。${durHint}
识别音频中出现的每个人声段所属类型（仅限："正常_人声段"、"耳语_人声段"、"气声_人声段"），以及对应的真实发声开始时间（start）和截止时间（end）。
注意：音频里说话人很可能已经直接说出了是什么类型的人声段（例如“正常”、“耳语”、“气声”），请结合内容与音色准确输出每一段的 vocal_type、start、end 和 spoken_cue。`;

      params.onStage?.('calibrating', 'AI 正在定位人声起止时间...');
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: {
            parts: [audioPart, { text: userPrompt }],
          },
          config: {
            systemInstruction: VOCAL_DETECT_SYSTEM_INSTRUCTION,
            thinkingConfig: {
              thinkingLevel: ThinkingLevel.MINIMAL,
            },
            responseMimeType: 'application/json',
            responseSchema: VOCAL_DETECT_RESPONSE_SCHEMA,
          },
        })
      );

      const responseText = (response.text ?? '').trim();
      if (!responseText) {
        throw new Error('模型返回为空，请重试。');
      }

      const parsed = JSON.parse(responseText) as {
        segments?: Array<{
          vocal_type?: string;
          start?: number;
          end?: number;
          spoken_cue?: string;
        }>;
      };

      const maxDur = params.durationSec && params.durationSec > 0 ? params.durationSec : Infinity;
      const segments = (parsed.segments ?? [])
        .map((seg) => {
          const rawStart = Number(seg.start);
          const rawEnd = Number(seg.end);
          const safeStart = Number.isFinite(rawStart)
            ? Math.max(0, Math.min(maxDur, rawStart))
            : 0;
          const safeEnd = Number.isFinite(rawEnd)
            ? Math.max(safeStart + 0.05, Math.min(maxDur, rawEnd))
            : Number.isFinite(maxDur)
              ? maxDur
              : safeStart + 1;
          return {
            type: normalizeVocalType(String(seg.vocal_type || '')),
            start: Number(safeStart.toFixed(2)),
            end: Number(safeEnd.toFixed(2)),
            spokenCue: typeof seg.spoken_cue === 'string' ? seg.spoken_cue.trim() : '',
          };
        })
        .filter((s) => s.end > s.start);

      return { segments };
    } finally {
      if (tempFilePathToClean) {
        fs.promises.unlink(tempFilePathToClean).catch(() => {});
      }
      if (uploadedFileName) {
        ai.files.delete({ name: uploadedFileName }).catch(() => {});
      }
    }
  }

  async function executeCalibrationFromFile(params: {
    filePath?: string;
    fileBuffer?: Buffer;
    fileSize: number;
    originalName: string;
    mimeType: string;
    parsedRef: {
      session_id: string;
      duration_sec: number;
      transcripts: TranscriptUtterance[];
      [key: string]: unknown;
    };
    customRules: string;
    timestampMode?: 'lock' | 'conservative';
    onStage?: (status: CalibrationJobState['status'], text: string) => void;
  }) {
    const timestampMode: 'lock' | 'conservative' =
      params.timestampMode === 'conservative' ? 'conservative' : 'lock';
    let tempFilePathToClean: string | null = params.filePath ?? null;
    let uploadedFileName: string | null = null;

    try {
      const mimeType = normalizeAudioMimeType(params.mimeType, params.originalName);

      let audioPart:
        | { inlineData: { mimeType: string; data: string } }
        | { fileData: { mimeType: string; fileUri: string } };

      if (params.fileSize <= 14 * 1024 * 1024) {
        const buf =
          params.fileBuffer ??
          (tempFilePathToClean ? await fs.promises.readFile(tempFilePathToClean) : null);
        if (!buf) {
          throw new Error('服务端未找到音频数据');
        }
        params.onStage?.('calibrating', 'AI 极速核对中...');
        audioPart = {
          inlineData: {
            mimeType,
            data: buf.toString('base64'),
          },
        };
      } else {
        if (!tempFilePathToClean && params.fileBuffer) {
          const ext = path.extname(params.originalName || '') || '.wav';
          tempFilePathToClean = path.join(os.tmpdir(), `asr-qa-${Date.now()}${ext}`);
          await fs.promises.writeFile(tempFilePathToClean, params.fileBuffer);
        }
        if (!tempFilePathToClean) {
          throw new Error('服务端未找到音频临时文件');
        }

        params.onStage?.('uploading', '正在将大音频上传至 Gemini 文件服务...');
        const uploaded = await withRetry(() =>
          ai.files.upload({
            file: tempFilePathToClean!,
            config: { mimeType },
          })
        );
        uploadedFileName = uploaded.name ?? null;

        let activeFile = uploaded;
        let waitAttempts = 0;
        while (activeFile.state === 'PROCESSING' && uploadedFileName && waitAttempts < 90) {
          params.onStage?.('processing_audio', 'Gemini 正在预处理音频波形...');
          await new Promise((r) => setTimeout(r, 2000));
          activeFile = await ai.files.get({ name: uploadedFileName });
          waitAttempts++;
        }
        if (activeFile.state === 'FAILED') {
          throw new Error('Gemini 文件服务解析该音频失败，请确认音频编码格式是否正常。');
        }

        audioPart = {
          fileData: {
            mimeType: activeFile.mimeType ?? mimeType,
            fileUri: activeFile.uri ?? '',
          },
        };
      }

      const systemInstruction = params.customRules
        ? `${BASE_SYSTEM_INSTRUCTION}\n\n### 四、 补充业务词库与角色约定\n${params.customRules}`
        : BASE_SYSTEM_INSTRUCTION;

      const allUtterances = Array.isArray(params.parsedRef.transcripts)
        ? params.parsedRef.transcripts
        : [];
      const distinctRoles = Array.from(
        new Set(
          allUtterances
            .map((u) => (typeof u.role === 'string' ? u.role.trim() : ''))
            .filter(Boolean)
        )
      );

      const SLICE_SIZE = 12;
      const slices: Array<{ startIdx: number; endIdx: number; items: TranscriptUtterance[] }> = [];
      for (let i = 0; i < allUtterances.length; i += SLICE_SIZE) {
        const endIdx = Math.min(allUtterances.length, i + SLICE_SIZE);
        slices.push({
          startIdx: i,
          endIdx,
          items: allUtterances.slice(i, endIdx),
        });
      }
      if (slices.length === 0) {
        slices.push({ startIdx: 0, endIdx: 0, items: [] });
      }

      const calibrateSlice = async (
        slice: { startIdx: number; endIdx: number; items: TranscriptUtterance[] },
        sliceIdx: number
      ): Promise<{ items: TranscriptUtterance[]; summary: string; status: string }> => {
        const expectedIds = slice.items.map((u) => u.utterance_id);
        const firstId = expectedIds[0];
        const lastId = expectedIds[expectedIds.length - 1];
        const winStart = slice.items[0]?.start ?? 0;
        const winEnd = slice.items[slice.items.length - 1]?.end ?? params.parsedRef.duration_sec;

        const prevContext =
          slice.startIdx > 0
            ? allUtterances.slice(Math.max(0, slice.startIdx - 2), slice.startIdx)
            : [];
        const nextContext =
          slice.endIdx < allUtterances.length
            ? allUtterances.slice(slice.endIdx, Math.min(allUtterances.length, slice.endIdx + 2))
            : [];

        const slicePayload = {
          session_id: params.parsedRef.session_id,
          duration_sec: params.parsedRef.duration_sec,
          transcripts: slice.items,
        };

        const runAttempt = async (missingHint?: number[]) => {
          const contextNote =
            prevContext.length > 0 || nextContext.length > 0
              ? `\n参考上下文（仅作时间/角色衔接参考，绝对不要输出在结果里）：\n前文：${JSON.stringify(prevContext)}\n后文：${JSON.stringify(nextContext)}\n`
              : '';

          const retryNote =
            missingHint && missingHint.length > 0
              ? `\n【严重警告】你上一次遗漏了以下 utterance_id：${missingHint.join(', ')}！这一次必须严格返回全部 ${slice.items.length} 条（utterance_id ${firstId} 到 ${lastId}），一条都不能少！\n`
              : '';

          const timestampInstruction =
            timestampMode === 'lock'
              ? `2. 严格锁定原时间戳：输入的 start / end 大部分是准确的 VAD 切分结果，请原封不动保留每条的 start 和 end（严禁修改或顺延时间戳），保持 duration_sec 为 ${params.parsedRef.duration_sec}。`
              : `2. 保守局部微调时间轴（严禁顺延）：输入的 start / end 大部分原本就是准确的，绝对禁止连锁顺延或平移后续语句时间戳！仅当某单句明显偏差超过 0.5s 时才允许孤立微调该句，其余原封不动保留，保持 duration_sec 为 ${params.parsedRef.duration_sec}，所有时间戳落在 [0, ${params.parsedRef.duration_sec}] 内。`;

          const roleConstraint =
            distinctRoles.length > 0
              ? `本次参考 JSON 中出现的说话人角色（role）集合为：${JSON.stringify(distinctRoles)}（如未在补充规则中另行指定，请严格从上述原有角色名称中选用，切勿擅自改写成未出现的角色名）。`
              : '严格核对每条的说话人 role。';

          const userPrompt = `请以这段真实音频的每一帧声音为绝对标准，逐条核对并修正下面这一批次的参考 JSON 转写数据（${
            slices.length > 1 ? `第 ${sliceIdx + 1}/${slices.length} 批次，` : ''
          }聚焦音频约 ${winStart.toFixed(2)}s 至 ${winEnd.toFixed(2)}s 区间）。
请注意：
1. 本批次必须一对一完整输出以下 ${slice.items.length} 条 utterance_id（${expectedIds.join(', ')}），严禁删除、跳过或合并任何一条！
${timestampInstruction}
3. 重点排查同音错别字、漏字吞字、真实语气词与说话人 role 错位。${roleConstraint}
4. 绝对忠于原声保留所有口误与改口（例如先说“整个”又马上改口说“穿个”，必须把“整个”和“穿个”全部保留，不可替说话人删除口误）。${retryNote}${contextNote}
待核对的本批次 JSON 数据如下：
${JSON.stringify(slicePayload, null, 2)}`;

          const response = await withRetry(() =>
            ai.models.generateContent({
              model: 'gemini-3.1-flash-lite',
              contents: {
                parts: [audioPart, { text: userPrompt }],
              },
              config: {
                systemInstruction,
                thinkingConfig: {
                  thinkingLevel: ThinkingLevel.MINIMAL,
                },
                responseMimeType: 'application/json',
                responseSchema: CALIBRATION_RESPONSE_SCHEMA,
              },
            })
          );

          const responseText = (response.text ?? '').trim();
          if (!responseText) {
            throw new Error('模型返回为空，请重试。');
          }
          const parsed = JSON.parse(responseText) as {
            results?: Array<{
              status?: string;
              summary?: string;
              corrected_json?: { transcripts?: TranscriptUtterance[] };
            }>;
          };
          const first = parsed.results?.[0];
          return {
            returnedList: first?.corrected_json?.transcripts ?? [],
            summary: first?.summary ?? '无修改',
            status: first?.status ?? '完全没错',
          };
        };

        let attempt = await runAttempt();
        let returnedMap = new Map<number, TranscriptUtterance>();
        for (const u of attempt.returnedList) {
          if (typeof u?.utterance_id === 'number') {
            returnedMap.set(u.utterance_id, u);
          }
        }

        const missingIds = expectedIds.filter((id) => !returnedMap.has(id));
        if (missingIds.length > 0) {
          attempt = await runAttempt(missingIds);
          returnedMap = new Map<number, TranscriptUtterance>();
          for (const u of attempt.returnedList) {
            if (typeof u?.utterance_id === 'number') {
              returnedMap.set(u.utterance_id, u);
            }
          }
        }

        // Guarantee 100% 1-to-1 preservation of every utterance_id in exact order
        const fallbackIds: number[] = [];
        const durationLimit = Number(params.parsedRef.duration_sec) || Infinity;
        const finalSliceItems: TranscriptUtterance[] = slice.items.map((orig) => {
          const calibrated = returnedMap.get(orig.utterance_id);
          if (calibrated) {
            let finalStart = orig.start;
            let finalEnd = orig.end;
            if (timestampMode === 'conservative') {
              const candStart = Number(calibrated.start);
              const candEnd = Number(calibrated.end);
              if (
                Number.isFinite(candStart) &&
                Number.isFinite(candEnd) &&
                candStart >= 0 &&
                candEnd <= durationLimit + 0.05 &&
                candStart < candEnd
              ) {
                finalStart = Number(candStart.toFixed(2));
                finalEnd = Number(candEnd.toFixed(2));
              }
            }
            return {
              ...orig,
              utterance_id: orig.utterance_id,
              role:
                typeof calibrated.role === 'string' && calibrated.role.trim()
                  ? calibrated.role.trim()
                  : orig.role,
              start: finalStart,
              end: finalEnd,
              text: typeof calibrated.text === 'string' ? calibrated.text : orig.text,
            };
          }
          fallbackIds.push(orig.utterance_id);
          return { ...orig };
        });

        const summaryNote =
          fallbackIds.length > 0
            ? `${attempt.summary}（注：#${fallbackIds.join(', #')} 已自动保底保留原条目）`
            : attempt.summary;

        return {
          items: finalSliceItems,
          summary: summaryNote,
          status: attempt.status,
        };
      };

      const sliceResults: Array<{ items: TranscriptUtterance[]; summary: string; status: string }> =
        new Array(slices.length);
      let completedSlices = 0;
      let cursor = 0;
      const SLICE_CONCURRENCY = Math.min(2, slices.length);

      const sliceWorker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= slices.length) break;
          params.onStage?.(
            'calibrating',
            slices.length > 1
              ? `AI 分片核对中 (${completedSlices}/${slices.length} 批 · 共 ${allUtterances.length} 条)...`
              : 'AI 极速核对中（无深度思考）...'
          );
          sliceResults[idx] = await calibrateSlice(slices[idx], idx);
          completedSlices++;
          params.onStage?.(
            'calibrating',
            slices.length > 1
              ? `AI 分片核对中 (${completedSlices}/${slices.length} 批 · 共 ${allUtterances.length} 条)...`
              : 'AI 极速核对中（无深度思考）...'
          );
        }
      };

      await Promise.all(Array.from({ length: SLICE_CONCURRENCY }, () => sliceWorker()));

      const mergedTranscripts = sliceResults.flatMap((r) => r.items);
      const anyModified = sliceResults.some((r) => r.status === '已修正') ||
        mergedTranscripts.some((u, idx) => {
          const orig = allUtterances[idx];
          return (
            !orig ||
            u.text !== orig.text ||
            u.role !== orig.role ||
            Math.abs(u.start - orig.start) >= 0.01 ||
            Math.abs(u.end - orig.end) >= 0.01
          );
        });

      const mergedSummary = anyModified
        ? sliceResults
            .filter((r) => r.summary && r.summary !== '无修改')
            .map((r) => r.summary)
            .join('；') || '已完成逐条核对与校准'
        : '无修改';

      return {
        results: [
          {
            session_id: params.parsedRef.session_id,
            status: anyModified ? '已修正' : '完全没错',
            summary: mergedSummary,
            corrected_json: {
              ...params.parsedRef,
              session_id: params.parsedRef.session_id,
              duration_sec: params.parsedRef.duration_sec,
              transcripts: mergedTranscripts,
            },
          },
        ],
      };
    } finally {
      if (tempFilePathToClean) {
        fs.promises.unlink(tempFilePathToClean).catch(() => {});
      }
      if (uploadedFileName) {
        ai.files.delete({ name: uploadedFileName }).catch(() => {});
      }
    }
  }

  // 1. Initialize chunked upload session for large audio files (100MB+)
  app.post('/api/upload-init', async (req, res) => {
    try {
      const { fileName, mimeType, totalChunks } = req.body ?? {};
      if (!fileName || !totalChunks || Number(totalChunks) <= 0) {
        res.status(400).json({ error: '缺少分片初始化参数 (fileName / totalChunks)。' });
        return;
      }
      const uploadId = crypto.randomUUID();
      const ext = path.extname(String(fileName)) || '.wav';
      const tempFilePath = path.join(os.tmpdir(), `asr-chunk-${uploadId}${ext}`);
      await fs.promises.writeFile(tempFilePath, Buffer.alloc(0));

      chunkUploads.set(uploadId, {
        uploadId,
        fileName: String(fileName),
        mimeType: String(mimeType || 'audio/wav'),
        totalChunks: Number(totalChunks),
        receivedChunks: new Set(),
        tempFilePath,
        createdAt: Date.now(),
      });

      res.json({ uploadId });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 2. Receive individual <= 8MB audio chunk (supports concurrent chunk uploads)
  app.post('/api/upload-chunk', upload.single('chunk'), async (req, res) => {
    try {
      const uploadId = String(req.body?.uploadId || '');
      const chunkIndex = Number(req.body?.chunkIndex);
      const file = req.file;

      const session = chunkUploads.get(uploadId);
      if (!session) {
        res.status(404).json({ error: '上传会话不存在或已过期，请重新启动任务。' });
        return;
      }
      if (!file || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
        res.status(400).json({ error: '无效的分片参数或缺少分片数据 (chunk)。' });
        return;
      }

      const partPath = `${session.tempFilePath}.part.${chunkIndex}`;
      await fs.promises.writeFile(partPath, file.buffer);
      session.receivedChunks.add(chunkIndex);

      res.json({
        ok: true,
        received: session.receivedChunks.size,
        totalChunks: session.totalChunks,
      });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 3. Start async calibration job from chunked upload (avoids 300s gateway timeout)
  app.post('/api/calibrate-start', async (req, res) => {
    try {
      const { uploadId, referenceJson, customRules, timestampMode } = req.body ?? {};
      const uploadSession = chunkUploads.get(String(uploadId || ''));
      if (!uploadSession) {
        res.status(404).json({ error: '上传会话不存在，请重试。' });
        return;
      }
      if (uploadSession.receivedChunks.size < uploadSession.totalChunks) {
        res.status(400).json({
          error: `音频分片未上传完整 (${uploadSession.receivedChunks.size}/${uploadSession.totalChunks})。`,
        });
        return;
      }

      let parsedRef: { session_id: string; duration_sec: number; transcripts: TranscriptUtterance[] };
      try {
        parsedRef = typeof referenceJson === 'string' ? JSON.parse(referenceJson) : referenceJson;
      } catch {
        res.status(400).json({ error: 'referenceJson 格式无效。' });
        return;
      }

      chunkUploads.delete(uploadSession.uploadId);

      // Assemble ordered part files cleanly into tempFilePath
      const outHandle = await fs.promises.open(uploadSession.tempFilePath, 'w');
      try {
        for (let i = 0; i < uploadSession.totalChunks; i++) {
          const partPath = `${uploadSession.tempFilePath}.part.${i}`;
          const partBuf = await fs.promises.readFile(partPath);
          await outHandle.write(partBuf);
          await fs.promises.unlink(partPath).catch(() => {});
        }
      } finally {
        await outHandle.close();
      }

      const stat = await fs.promises.stat(uploadSession.tempFilePath);
      const jobId = crypto.randomUUID();
      const job: CalibrationJobState = {
        jobId,
        status: 'queued',
        progressText: '已进入校准队列...',
        createdAt: Date.now(),
      };
      calibrationJobs.set(jobId, job);

      // Run calibration asynchronously in background
      (async () => {
        try {
          const result = await executeCalibrationFromFile({
            filePath: uploadSession.tempFilePath,
            fileSize: stat.size,
            originalName: uploadSession.fileName,
            mimeType: uploadSession.mimeType,
            parsedRef,
            customRules: typeof customRules === 'string' ? customRules.trim() : '',
            timestampMode: timestampMode === 'conservative' ? 'conservative' : 'lock',
            onStage: (status, progressText) => {
              const current = calibrationJobs.get(jobId);
              if (current) {
                current.status = status;
                current.progressText = progressText;
              }
            },
          });
          const current = calibrationJobs.get(jobId);
          if (current) {
            current.status = 'completed';
            current.progressText = '校准完成';
            current.result = result;
          }
        } catch (err) {
          const formatted = formatGeminiError(err);
          const current = calibrationJobs.get(jobId);
          if (current) {
            current.status = 'error';
            current.progressText = '校准失败';
            current.error = formatted.message;
          }
        }
      })();

      res.status(202).json({ jobId });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 4. Poll async calibration job progress
  app.get('/api/jobs/:jobId', (req, res) => {
    const job = calibrationJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: '校准任务不存在或已过期。' });
      return;
    }
    res.json(job);
  });

  // Direct single-request endpoint (for small <= 25MB files)
  app.post('/api/calibrate', upload.single('audio'), async (req, res) => {
    try {
      const file = req.file;
      const rawJson = req.body?.referenceJson;
      const customRules = typeof req.body?.customRules === 'string' ? req.body.customRules.trim() : '';
      const timestampMode = req.body?.timestampMode === 'conservative' ? 'conservative' : 'lock';

      if (!file) {
        res.status(400).json({ error: '缺少音频文件 (audio)。' });
        return;
      }
      if (!rawJson || typeof rawJson !== 'string') {
        res.status(400).json({ error: '缺少参考转写 JSON (referenceJson)。' });
        return;
      }

      let parsedRef: { session_id: string; duration_sec: number; transcripts: TranscriptUtterance[] };
      try {
        parsedRef = JSON.parse(rawJson);
      } catch {
        res.status(400).json({ error: 'referenceJson 不是有效的 JSON 字符串。' });
        return;
      }

      const resultJson = await executeCalibrationFromFile({
        fileBuffer: file.buffer,
        fileSize: file.size,
        originalName: file.originalname,
        mimeType: file.mimetype,
        parsedRef,
        customRules,
        timestampMode,
      });

      res.json(resultJson);
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Vocal segment detection (async job from chunked upload for > 6MB files)
  app.post('/api/vocal-detect-start', async (req, res) => {
    try {
      const { uploadId, durationSec } = req.body ?? {};
      const uploadSession = chunkUploads.get(String(uploadId || ''));
      if (!uploadSession) {
        res.status(404).json({ error: '上传会话不存在，请重试。' });
        return;
      }
      if (uploadSession.receivedChunks.size < uploadSession.totalChunks) {
        res.status(400).json({
          error: `音频分片未上传完整 (${uploadSession.receivedChunks.size}/${uploadSession.totalChunks})。`,
        });
        return;
      }

      chunkUploads.delete(uploadSession.uploadId);

      const outHandle = await fs.promises.open(uploadSession.tempFilePath, 'w');
      try {
        for (let i = 0; i < uploadSession.totalChunks; i++) {
          const partPath = `${uploadSession.tempFilePath}.part.${i}`;
          const partBuf = await fs.promises.readFile(partPath);
          await outHandle.write(partBuf);
          await fs.promises.unlink(partPath).catch(() => {});
        }
      } finally {
        await outHandle.close();
      }

      const stat = await fs.promises.stat(uploadSession.tempFilePath);
      const jobId = crypto.randomUUID();
      calibrationJobs.set(jobId, {
        jobId,
        status: 'queued',
        progressText: '已进入人声识别队列...',
        createdAt: Date.now(),
      });

      (async () => {
        try {
          const result = await executeVocalDetectionFromFile({
            filePath: uploadSession.tempFilePath,
            fileSize: stat.size,
            originalName: uploadSession.fileName,
            mimeType: uploadSession.mimeType,
            durationSec: Number(durationSec) || undefined,
            onStage: (status, progressText) => {
              const current = calibrationJobs.get(jobId);
              if (current) {
                current.status = status;
                current.progressText = progressText;
              }
            },
          });
          const current = calibrationJobs.get(jobId);
          if (current) {
            current.status = 'completed';
            current.progressText = '人声段识别完成';
            current.result = result;
          }
        } catch (err) {
          const formatted = formatGeminiError(err);
          const current = calibrationJobs.get(jobId);
          if (current) {
            current.status = 'error';
            current.progressText = '识别失败';
            current.error = formatted.message;
          }
        }
      })();

      res.status(202).json({ jobId });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Vocal segment detection (direct single-request endpoint for <= 25MB files)
  app.post('/api/vocal-detect', upload.single('audio'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: '缺少音频文件 (audio)。' });
        return;
      }
      const durationSec = Number(req.body?.durationSec) || undefined;
      const result = await executeVocalDetectionFromFile({
        fileBuffer: file.buffer,
        fileSize: file.size,
        originalName: file.originalname,
        mimeType: file.mimetype,
        durationSec,
      });
      res.json(result);
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/demo-sample', async (_req, res) => {
    try {
      const ttsPrompt = `请用自然口语化的中文朗读下面这段对话：
User: 哎哟，等一下等一下，这面墙我怕钉膨胀螺丝会裂掉，旁边还堆着这么多杂物。
Assistant: 没关系的，等孩子大一点我们再把脚踏挡板往外移一丢丢就行，先试试看行不行。
User: 嗯，行，那我们先定在这边好了。`;

      let response;
      try {
        response = await withRetry(() =>
          aiAlpha.models.generateContent({
            model: 'gemini-3.8-flash-tts',
            contents: [{ role: 'user', parts: [{ text: ttsPrompt }] }],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                multiSpeakerVoiceConfig: {
                  speakerVoiceConfigs: [
                    {
                      speaker: 'User',
                      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
                    },
                    {
                      speaker: 'Assistant',
                      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
                    },
                  ],
                },
              },
            },
          })
        );
      } catch {
        response = await withRetry(() =>
          ai.models.generateContent({
            model: 'gemini-3.8-flash-lite-tts',
            contents: [{ role: 'user', parts: [{ text: ttsPrompt }] }],
            config: {
              responseModalities: ['AUDIO'],
            },
          })
        );
      }

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        res.status(502).json({ error: '未能生成示例语音音频，请稍后重试或直接上传本地音频。' });
        return;
      }

      const wavBuffer = Buffer.from(base64Audio, 'base64');
      const durationSec = Math.max(1, getWavDurationSeconds(wavBuffer));

      // Construct a deliberately flawed reference ASR JSON proportional to the real audio duration
      const t1End = Number((durationSec * 0.42).toFixed(2));
      const t2Start = Number((durationSec * 0.44).toFixed(2));
      const t2End = Number((durationSec * 0.84).toFixed(2));
      const t3Start = Number((durationSec * 0.85).toFixed(2));
      const t3End = Number((durationSec * 0.98).toFixed(2));

      const referenceJson = {
        session_id: 'demo_home_safety_01',
        duration_sec: durationSec,
        transcripts: [
          {
            utterance_id: 1,
            role: 'user',
            start: 0.0,
            end: Math.max(0.5, Number((t1End - 0.6).toFixed(2))), // intentionally shifted earlier
            text: '等一下，这面墙我怕定螺丝会裂掉，旁边还堆出这么多杂物。',
          },
          {
            utterance_id: 2,
            role: 'user', // intentionally wrong speaker role (should be assistant)
            start: Math.max(0.6, Number((t2Start - 0.65).toFixed(2))), // cascading timestamp offset
            end: Math.max(1.2, Number((t2End - 0.55).toFixed(2))),
            text: '没关系的，我们再把脚打烫法往外移一点就行，先试试看强不强。',
          },
          {
            utterance_id: 3,
            role: 'user',
            start: Math.max(1.3, Number((t3Start - 0.5).toFixed(2))),
            end: t3End,
            text: '行，那我们先定在这边好了。',
          },
        ],
      };

      res.json({
        fileName: 'demo_home_safety_01.wav',
        mimeType: 'audio/wav',
        audioSize: wavBuffer.length,
        audioBase64: base64Audio,
        referenceJson,
      });
    } catch (err) {
      const formatted = formatGeminiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : '服务端请求处理异常';
    res.status(400).json({ error: message });
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.env.ASR_WEB_ROOT || path.resolve(process.cwd(), 'dist'));
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, serverHost, () => {
      console.log(`ASR Calibration Workbench server running on http://${serverHost}:${port}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}

if (process.env.ASR_DESKTOP !== 'true') {
  startServer().catch((error) => {
    console.error('ASR Calibration Workbench server failed to start:', error);
    process.exitCode = 1;
  });
}
