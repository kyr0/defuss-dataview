import type { CompiledQuery } from './query.js';
import type { DataviewRow } from './types.js';
import { TopK } from './stream/heap.js';

/** Select a shallow stable prefix, retaining adaptive native sort for reverse runs. */
export function flatPage<T extends DataviewRow>(rows: readonly T[], query: CompiledQuery, end: number): { rows: T[]; total: number } {
  const sample: T[] = [];
  let next = 0, reverse = true, strict = false;
  // Sampling matching rows preserves filter-once semantics. A false positive
  // changes only the algorithm: native sorting still evaluates the complete set.
  while (next < rows.length && sample.length < 32) {
    const row = rows[next++];
    if (!query.matches(row)) continue;
    if (sample.length) {
      const c = query.compare(sample[sample.length - 1], row);
      reverse &&= c >= 0; strict ||= c > 0;
    }
    sample.push(row);
  }
  if (reverse && strict) {
    for (; next < rows.length; next++) if (query.matches(rows[next])) sample.push(rows[next]);
    const total = sample.length;
    sample.sort(query.compare);
    return { rows: sample.slice(0, end), total };
  }
  type Candidate = { row: T; ordinal: number };
  const compare = (a: Candidate, b: Candidate) => query.compare(a.row, b.row) || a.ordinal - b.ordinal;
  const heap = new TopK<Candidate>(end, compare);
  let total = 0;
  const add = (row: T) => {
    const ordinal = total++;
    if (heap.items.length < end) heap.addAccepted({ row, ordinal });
    else if (query.compare(row, heap.items[0].row) < 0) {
      const candidate = heap.items[0];
      candidate.row = row; candidate.ordinal = ordinal;
      heap.addAccepted(candidate);
    }
  };
  for (const row of sample) add(row);
  for (; next < rows.length; next++) if (query.matches(rows[next])) add(rows[next]);
  heap.items.sort(compare);
  return { rows: heap.items.map(c => c.row), total };
}
