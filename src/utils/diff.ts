export interface DiffSegment {
  type: 'equal' | 'insert' | 'delete';
  value: string;
}

/**
 * Character-level Longest Common Subsequence diff tuned for CJK + Latin ASR transcripts.
 */
export function computeCharDiff(original: string, corrected: string): DiffSegment[] {
  if (original === corrected) {
    return original ? [{ type: 'equal', value: original }] : [];
  }

  const a = Array.from(original);
  const b = Array.from(corrected);
  const m = a.length;
  const n = b.length;

  // Guard against extreme lengths
  if (m * n > 250000) {
    return [
      { type: 'delete', value: original },
      { type: 'insert', value: corrected },
    ];
  }

  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const raw: DiffSegment[] = [];
  let i = 0;
  let j = 0;

  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push({ type: 'equal', value: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ type: 'delete', value: a[i] });
      i++;
    } else {
      raw.push({ type: 'insert', value: b[j] });
      j++;
    }
  }

  while (i < m) {
    raw.push({ type: 'delete', value: a[i++] });
  }
  while (j < n) {
    raw.push({ type: 'insert', value: b[j++] });
  }

  // Coalesce adjacent segments of the same type
  const merged: DiffSegment[] = [];
  for (const seg of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === seg.type) {
      prev.value += seg.value;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged;
}

export function formatSec(sec: number): string {
  if (!Number.isFinite(sec)) return '0.00s';
  return `${sec.toFixed(2)}s`;
}

export function formatDelta(delta: number): string {
  if (Math.abs(delta) < 0.005) return '0.00s';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(2)}s`;
}
