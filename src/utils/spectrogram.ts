const FFT_SIZE = 1024;
const WINDOW = Float32Array.from({ length: FFT_SIZE }, (_, i) =>
  0.54 - 0.46 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1))
);
const COS = Float32Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.cos(-2 * Math.PI * i / FFT_SIZE));
const SIN = Float32Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.sin(-2 * Math.PI * i / FFT_SIZE));
const REVERSED = new Uint16Array(FFT_SIZE);
for (let i = 1; i < FFT_SIZE; i++) {
  REVERSED[i] = (REVERSED[i >> 1] >> 1) | ((i & 1) * (FFT_SIZE >> 1));
}

function fft(real: Float32Array, imag: Float32Array) {
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    for (let k = 0; k < half; k++) {
      const twiddle = k * (FFT_SIZE / size);
      const cos = COS[twiddle];
      const sin = SIN[twiddle];
      for (let i = k; i < FFT_SIZE; i += size) {
        const j = i + half;
        const re = real[j] * cos - imag[j] * sin;
        const im = real[j] * sin + imag[j] * cos;
        real[j] = real[i] - re;
        imag[j] = imag[i] - im;
        real[i] += re;
        imag[i] += im;
      }
    }
  }
}

const frequencyScale = (hz: number) => Math.log1p(hz / 300);
const clampLevel = (level: number) => Math.max(0, Math.min(1, level));

export function drawSpectrogram(
  canvas: HTMLCanvasElement,
  channels: Float32Array[],
  sampleRate: number,
  start: number,
  duration: number,
  columns: number
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = Math.min(640, Math.max(1, Math.round(columns)));
  const rows = 128;
  const maxHz = Math.min(12000, sampleRate / 2);
  canvas.width = width;
  canvas.height = rows * channels.length;
  const image = ctx.createImageData(width, canvas.height);
  const real = new Float32Array(FFT_SIZE);
  const imag = new Float32Array(FFT_SIZE);
  const energy = new Float32Array(width * rows);
  const backgroundSamples = new Float32Array(Math.min(width, 24));
  const bins = Float32Array.from({ length: rows }, (_, y) =>
    300 * Math.expm1((1 - y / (rows - 1)) * frequencyScale(maxHz)) * FFT_SIZE / sampleRate
  );

  channels.forEach((samples, channel) => {
    for (let x = 0; x < width; x++) {
      const center = Math.round((start + (x + 0.5) * duration / width) * sampleRate);
      for (let i = 0; i < FFT_SIZE; i++) {
        real[REVERSED[i]] = (samples[center + i - FFT_SIZE / 2] ?? 0) * WINDOW[i];
      }
      imag.fill(0);
      fft(real, imag);
      for (let y = 0; y < rows; y++) {
        const bin = Math.min(FFT_SIZE / 2 - 1, Math.floor(bins[y]));
        const mix = bins[y] - bin;
        const low = real[bin] ** 2 + imag[bin] ** 2;
        const high = real[bin + 1] ** 2 + imag[bin + 1] ** 2;
        energy[y * width + x] = 10 * Math.log10(Math.max(1e-12, (low + (high - low) * mix) * (4 / FFT_SIZE) ** 2));
      }
    }

    for (let y = 0; y < rows; y++) {
      const row = y * width;
      for (let i = 0; i < backgroundSamples.length; i++) {
        backgroundSamples[i] = energy[row + Math.floor(i * width / backgroundSamples.length)];
      }
      backgroundSamples.sort();
      const floor = backgroundSamples[Math.floor(backgroundSamples.length * 0.25)];
      for (let x = 0; x < width; x++) {
        const db = energy[row + x];
        const absolute = clampLevel((db + 90) / 75);
        const contrast = clampLevel((db - floor - 3) / 24);
        const level = absolute * 0.45 + contrast * 0.55;
        const offset = ((channel * rows + y) * width + x) * 4;
        image.data[offset] = 8 + 247 * clampLevel(level * 1.35);
        image.data[offset + 1] = 10 + 236 * level ** 2.5;
        image.data[offset + 2] = 22 + 115 * level * (1 - level);
        image.data[offset + 3] = 255;
      }
    }
  });
  ctx.putImageData(image, 0, 0);
}
