import { QASessionItem, TranscriptSession, Utterance, ValidationIssue } from '../types/asr';

export const CORE_UTTERANCE_KEYS = new Set(['utterance_id', 'role', 'start', 'end', 'text']);
export const DEFAULT_ROLES = ['user', 'assistant'];

export function extractExtraUtteranceColumns(transcripts: Utterance[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const item of transcripts) {
    if (!item || typeof item !== 'object') continue;
    for (const k of Object.keys(item)) {
      if (!CORE_UTTERANCE_KEYS.has(k) && !seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

export function extractAllRoles(
  activeSession?: QASessionItem | null,
  allSessions: QASessionItem[] = [],
  customRoles: string[] = []
): string[] {
  const seen = new Set<string>();
  const roles: string[] = [];

  const pushRole = (r: unknown) => {
    if (typeof r !== 'string') return;
    const trimmed = r.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      roles.push(trimmed);
    }
  };

  if (activeSession) {
    for (const u of activeSession.calibratedResult?.corrected_json.transcripts ?? []) {
      pushRole(u.role);
    }
    for (const u of activeSession.referenceJson.transcripts) {
      pushRole(u.role);
    }
  }

  for (const s of allSessions) {
    for (const u of s.calibratedResult?.corrected_json.transcripts ?? []) {
      pushRole(u.role);
    }
    for (const u of s.referenceJson.transcripts) {
      pushRole(u.role);
    }
  }

  for (const r of customRoles) {
    pushRole(r);
  }

  for (const r of DEFAULT_ROLES) {
    pushRole(r);
  }

  return roles;
}

export function areUtteranceExtraFieldsEqual(
  a: Utterance,
  b: Utterance,
  extraColumns: string[]
): boolean {
  for (const col of extraColumns) {
    const va = a[col];
    const vb = b[col];
    if (va === vb) continue;
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      return false;
    }
  }
  return true;
}

export function validateTranscriptSession(
  session: TranscriptSession,
  reference?: TranscriptSession
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!session.session_id || typeof session.session_id !== 'string') {
    issues.push({
      severity: 'error',
      code: 'INVALID_SESSION_ID',
      message: '缺少有效的 session_id 字符串。',
    });
  }

  if (typeof session.duration_sec !== 'number' || session.duration_sec <= 0) {
    issues.push({
      severity: 'error',
      code: 'INVALID_DURATION',
      message: 'duration_sec 必须为大于 0 的数值。',
    });
  }

  if (!Array.isArray(session.transcripts) || session.transcripts.length === 0) {
    issues.push({
      severity: 'error',
      code: 'EMPTY_TRANSCRIPTS',
      message: 'transcripts 数组不能为空。',
    });
    return issues;
  }

  if (reference && session.transcripts.length !== reference.transcripts.length) {
    issues.push({
      severity: 'warning',
      code: 'UTTERANCE_COUNT_DIFF',
      message: `条目数量从参考数据的 ${reference.transcripts.length} 条变为 ${session.transcripts.length} 条，请确认是否为补漏或合并拆分。`,
    });
  }

  const seenIds = new Set<number>();
  let prevStart = -1;

  for (const item of session.transcripts) {
    if (seenIds.has(item.utterance_id)) {
      issues.push({
        utterance_id: item.utterance_id,
        severity: 'error',
        code: 'DUPLICATE_ID',
        message: `utterance_id #${item.utterance_id} 存在重复。`,
      });
    }
    seenIds.add(item.utterance_id);

    if (item.start < 0 || item.end > session.duration_sec + 0.05) {
      issues.push({
        utterance_id: item.utterance_id,
        severity: 'error',
        code: 'OUT_OF_BOUNDS',
        message: `#${item.utterance_id} 时间轴 (${item.start.toFixed(2)}s - ${item.end.toFixed(2)}s) 超出音频范围 [0, ${session.duration_sec.toFixed(2)}s]。`,
      });
    }

    if (item.start >= item.end) {
      issues.push({
        utterance_id: item.utterance_id,
        severity: 'error',
        code: 'INVERTED_TIMESTAMP',
        message: `#${item.utterance_id} 起始时间 (${item.start.toFixed(2)}s) 必须小于结束时间 (${item.end.toFixed(2)}s)。`,
      });
    }

    if (item.start < prevStart) {
      issues.push({
        utterance_id: item.utterance_id,
        severity: 'warning',
        code: 'NON_MONOTONIC',
        message: `#${item.utterance_id} 起始时间 (${item.start.toFixed(2)}s) 早于上一句起始时间 (${prevStart.toFixed(2)}s)。`,
      });
    }
    prevStart = item.start;

    if (!item.role || !item.role.trim()) {
      issues.push({
        utterance_id: item.utterance_id,
        severity: 'error',
        code: 'EMPTY_ROLE',
        message: `#${item.utterance_id} 缺少说话人 role。`,
      });
    }

    if (!item.text || !item.text.trim()) {
      issues.push({
        utterance_id: item.utterance_id,
        severity: 'warning',
        code: 'EMPTY_TEXT',
        message: `#${item.utterance_id} 转写文本为空。`,
      });
    }
  }

  return issues;
}

export function parseReferenceJsonInput(rawText: string): {
  session?: TranscriptSession;
  error?: string;
} {
  try {
    const parsed = JSON.parse(rawText);

    // Support direct utterance array paste, or wrapped { corrected_json } / { results: [...] }
    let target = parsed;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      typeof parsed[0] === 'object' &&
      parsed[0] !== null &&
      !Array.isArray(parsed[0].transcripts) &&
      (typeof parsed[0].text === 'string' || typeof parsed[0].utterance_id === 'number')
    ) {
      target = {
        session_id: 'session_001',
        transcripts: parsed,
      };
    } else if (Array.isArray(parsed?.results) && parsed.results[0]?.corrected_json) {
      target = parsed.results[0].corrected_json;
    } else if (parsed?.corrected_json) {
      target = parsed.corrected_json;
    }

    if (!target || typeof target !== 'object' || !Array.isArray(target.transcripts)) {
      return {
        error: 'JSON 结构需包含 transcripts (array)，建议同时包含 session_id 与 duration_sec。',
      };
    }

    const transcripts: Utterance[] = target.transcripts.map(
      (u: Record<string, unknown>, idx: number) => ({
        ...u,
        utterance_id: typeof u.utterance_id === 'number' ? u.utterance_id : idx + 1,
        role: typeof u.role === 'string' && u.role.trim() ? u.role.trim() : 'user',
        start: Number(u.start ?? 0),
        end: Number(u.end ?? 0),
        text: typeof u.text === 'string' ? u.text : '',
      })
    );

    const maxEnd = transcripts.reduce((m, u) => (Number.isFinite(u.end) && u.end > m ? u.end : m), 0);
    const rawDuration = Number(target.duration_sec);
    const duration_sec =
      Number.isFinite(rawDuration) && rawDuration > 0
        ? rawDuration
        : maxEnd > 0
          ? Number(maxEnd.toFixed(2))
          : 0;

    const normalized: TranscriptSession = {
      ...target,
      session_id:
        typeof target.session_id === 'string' && target.session_id.trim()
          ? target.session_id.trim()
          : 'session_001',
      duration_sec,
      transcripts,
    };

    return { session: normalized };
  } catch (err) {
    return {
      error: err instanceof Error ? `JSON 解析失败：${err.message}` : 'JSON 格式无效。',
    };
  }
}
