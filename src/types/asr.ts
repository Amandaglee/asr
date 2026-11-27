export interface Utterance {
  utterance_id: number;
  role: string;
  start: number;
  end: number;
  text: string;
  [key: string]: unknown;
}

export interface TranscriptSession {
  session_id: string;
  duration_sec: number;
  transcripts: Utterance[];
  [key: string]: unknown;
}

export type CalibrationStatus = '完全没错' | '已修正';

export interface CalibrationResultItem {
  session_id: string;
  status: CalibrationStatus;
  summary: string;
  corrected_json: TranscriptSession;
}

export interface CalibrationBatchOutput {
  results: CalibrationResultItem[];
}

export type SessionJobState = 'pending' | 'processing' | 'completed' | 'error';

export interface QASessionItem {
  id: string;
  audioName: string;
  sourceJsonName?: string;
  audioMimeType: string;
  audioSize: number;
  audioUrl: string;
  audioFile?: File;
  audioBase64?: string;
  referenceJson: TranscriptSession;
  calibratedResult?: CalibrationResultItem;
  refAnchorMap?: Record<number, number>;
  appliedCustomRules?: string;
  appliedTimestampMode?: 'lock' | 'conservative';
  jobState: SessionJobState;
  errorMessage?: string;
  lastUpdatedAt: number;
}

export interface ValidationIssue {
  utterance_id?: number;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export type VocalSegmentType = '正常_人声段' | '耳语_人声段' | '气声_人声段';
export type VocalGender = '男声' | '女声';

export interface VocalSegment {
  id: string;
  type: VocalSegmentType;
  gender?: VocalGender;
  role?: string;
  start: number;
  end: number;
  spokenCue?: string;
}

export interface VocalAudioItem {
  id: string;
  queryId: string;
  audioName: string;
  audioMimeType: string;
  audioSize: number;
  audioUrl: string;
  audioFile?: File;
  durationSec: number;
  detectedTypeFromName?: VocalSegmentType;
  segments: VocalSegment[];
  confirmed: boolean;
  jobState: SessionJobState;
  errorMessage?: string;
}

