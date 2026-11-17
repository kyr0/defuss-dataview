// Experimental kernels retained with raw measurements, including rejected variants.
export function scalar(a, b) {
  for (let i = 0, n = Math.min(a.length, b.length); i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function unroll4(a, b) {
  const n = Math.min(a.length, b.length); let i = 0;
  for (; i + 3 < n; i += 4) {
    if (a[i] !== b[i]) return a[i] - b[i];
    if (a[i + 1] !== b[i + 1]) return a[i + 1] - b[i + 1];
    if (a[i + 2] !== b[i + 2]) return a[i + 2] - b[i + 2];
    if (a[i + 3] !== b[i + 3]) return a[i + 3] - b[i + 3];
  }
  for (; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function unroll8(a, b) {
  const n = Math.min(a.length, b.length); let i = 0;
  for (; i + 7 < n; i += 8) {
    if (a[i] !== b[i]) return a[i] - b[i];
    if (a[i + 1] !== b[i + 1]) return a[i + 1] - b[i + 1];
    if (a[i + 2] !== b[i + 2]) return a[i + 2] - b[i + 2];
    if (a[i + 3] !== b[i + 3]) return a[i + 3] - b[i + 3];
    if (a[i + 4] !== b[i + 4]) return a[i + 4] - b[i + 4];
    if (a[i + 5] !== b[i + 5]) return a[i + 5] - b[i + 5];
    if (a[i + 6] !== b[i + 6]) return a[i + 6] - b[i + 6];
    if (a[i + 7] !== b[i + 7]) return a[i + 7] - b[i + 7];
  }
  for (; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function words(a, b) {
  const n = Math.min(a.length, b.length); let i = 0;
  if (n >= 64) {
    const x = new DataView(a.buffer, a.byteOffset, a.length), y = new DataView(b.buffer, b.byteOffset, b.length);
    for (; i + 3 < n; i += 4) if (x.getUint32(i) !== y.getUint32(i)) break;
  }
  for (; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function runBinaryBenchmark(engine) {
  const kernels = { scalar, unroll4, unroll8, words }, results = [];
  // Exhaustive tails, visible-view alignment and mismatch position check exact differences.
  for (let n = 0; n <= 140; n++) for (let offset = 0; offset < 4; offset++) {
    const a = new Uint8Array(n + offset).subarray(offset), b = a.slice();
    for (let pos = -1; pos < n; pos++) {
      if (pos >= 0) b[pos] = 137;
      for (const f of Object.values(kernels)) if (f(a, b) !== scalar(a, b) || f(b, a) !== scalar(b, a)) throw Error('Kernel mismatch');
      if (pos >= 0) b[pos] = 0;
    }
    for (const f of Object.values(kernels)) if (f(a, new Uint8Array(n + 1)) !== -1) throw Error('Length mismatch');
  }
  let checksum = 0;
  for (const length of [16, 64, 256, 4096]) for (const offset of [0, 1]) for (const mismatch of ['equal', 'start', 'end']) {
    const pairs = Array.from({ length: 8 }, (_, seed) => {
      const a = Uint8Array.from({ length: length + offset }, (_, i) => (i + seed) % 251).subarray(offset), b = a.slice();
      if (mismatch !== 'equal') b[mismatch === 'start' ? 0 : length - 1] ^= 127;
      return [a, b];
    });
    const iterations = mismatch === 'start' ? 1000000 : Math.min(100000, Math.max(5000, Math.floor(4_000_000 / length)));
    const samples = Object.fromEntries(Object.keys(kernels).map(name => [name, []]));
    for (let round = 0; round < 9; round++) {
      const names = Object.keys(kernels); if (round % 2) names.reverse();
      for (const name of names) {
        const f = kernels[name]; let sum = 0; const t = performance.now();
        for (let i = 0; i < iterations; i++) { const [a, b] = pairs[i & 7]; sum += f(a, b); }
        const elapsed = performance.now() - t; checksum += sum;
        if (round >= 2) samples[name].push(elapsed);
      }
    }
    results.push({ length, offset, mismatch, iterations, variants: Object.fromEntries(Object.entries(samples).map(([name, samplesMs]) => [name, { medianMs: [...samplesMs].sort((a,b) => a-b)[3], samplesMs }])) });
  }
  return { engine, measuredAt: new Date().toISOString(), checksum, method: 'Two warmups, seven alternating-order samples per kernel and case; exact-result assertions. 4 million nominal bytes/sample, 5000..100000 calls for equal/end cases; 1 million for early mismatches to exceed browser timer resolution. Shared host; microbenchmarks do not imply whole-query speedups.', results };
}
