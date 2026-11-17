/** Hashes influence popularity only. Exact field strings identify cached data. */
export function mix(value: number): number {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}
export function hashText(text: string, seed = 2166136261): number {
  let hash = seed;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return mix(hash);
}
/** Bounded first-touch history; collisions can admit early, never change results. */
export class SecondTouch {
  private readonly history = new Set<number>();
  readonly metadataBytes = 512 * 32;
  record(hash: number): number {
    if (this.history.has(hash)) { this.history.delete(hash); this.history.add(hash); return 2; }
    if (this.history.size === 512) this.history.delete(this.history.values().next().value!);
    this.history.add(hash); return 1;
  }
  estimate(_hash: number): number { return 0; }
}
/** TinyLFU-style admission: Bloom doorkeeper, four-way count-min and aging. */
export class FrequencyAdmission {
  private readonly door = new Uint32Array(32);
  private readonly counts = new Uint8Array(4096);
  private samples = 0;
  readonly metadataBytes = 128 + 4096;
  private positions(hash: number): [number, number, number, number] {
    return [hash & 1023, 1024 + (mix(hash ^ 0x9e3779b9) & 1023), 2048 + (mix(hash ^ 0x85ebca6b) & 1023), 3072 + (mix(hash ^ 0xc2b2ae35) & 1023)];
  }
  private present(hash: number): boolean {
    const a = hash & 1023, b = mix(hash ^ 0x27d4eb2d) & 1023;
    return !!(this.door[a >>> 5] & (1 << (a & 31))) && !!(this.door[b >>> 5] & (1 << (b & 31)));
  }
  estimate(hash: number): number {
    const p = this.positions(hash);
    return Math.min(this.counts[p[0]], this.counts[p[1]], this.counts[p[2]], this.counts[p[3]]) + Number(this.present(hash));
  }
  record(hash: number): number {
    if (++this.samples === 10000) {
      for (let i = 0; i < this.counts.length; i++) this.counts[i] >>>= 1;
      this.door.fill(0); this.samples = 0;
    }
    if (!this.present(hash)) {
      const a = hash & 1023, b = mix(hash ^ 0x27d4eb2d) & 1023;
      this.door[a >>> 5] |= 1 << (a & 31); this.door[b >>> 5] |= 1 << (b & 31);
    } else {
      const p = this.positions(hash), min = Math.min(...p.map(i => this.counts[i]));
      if (min < 15) for (const i of p) if (this.counts[i] === min) this.counts[i]++;
    }
    return this.estimate(hash);
  }
}
