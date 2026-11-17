import { describe, it, expect } from 'vitest';
import { TopK } from './heap.js';

describe('recycled heap entries', () => {
  it('preserves stable top-k under repeated replacement for capacities 1..67', () => {
    for (const capacity of [1, 2, 3, 16, 67]) {
      type Item = { value: number; ordinal: number };
      const compare = (a: Item, b: Item) => b.value - a.value || a.ordinal - b.ordinal;
      const heap = new TopK<Item>(capacity, compare), expected: Item[] = [];
      const nodes = new Set<Item>();
      for (let ordinal = 0; ordinal < 1500; ordinal++) {
        const value = Math.floor(ordinal / 3); expected.push({ value, ordinal });
        if (heap.items.length < capacity) { const item = { value, ordinal }; nodes.add(item); heap.addAccepted(item); }
        else if (compare({ value, ordinal }, heap.items[0]) < 0) {
          const root = heap.items[0]; root.value = value; root.ordinal = ordinal; heap.addAccepted(root);
        }
        expect(new Set(heap.items).size).toBe(heap.items.length);
      }
      expect([...heap.items].sort(compare)).toEqual(expected.sort(compare).slice(0, capacity));
      expect(nodes.size).toBe(capacity);
    }
  });
});
