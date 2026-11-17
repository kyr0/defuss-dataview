/** Max-heap: root is the worst retained candidate. Stable ordinal breaks query ties. */
export class TopK<T> {
  readonly items: T[] = [];
  constructor(readonly capacity: number, private readonly compare: (a: T, b: T) => number) {}
  /** Caller checked ordering/admission. A full heap may reuse its mutated root;
   * sifting compares only its children before placing that root in its new slot. */
  addAccepted(value: T): T | undefined {
    // Unpaged sorting needs collection, not heap maintenance before its final sort.
    if (this.capacity === Infinity) { this.items.push(value); return undefined; }
    if (this.items.length < this.capacity) {
      let index = this.items.length;
      this.items.push(value);
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (this.compare(this.items[parent], value) >= 0) break;
        this.items[index] = this.items[parent]; index = parent;
      }
      this.items[index] = value;
      return undefined;
    }
    const evicted = this.items[0];
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.items.length && this.compare(this.items[child + 1], this.items[child]) > 0) child++;
      if (this.compare(value, this.items[child]) >= 0) break;
      this.items[index] = this.items[child]; index = child;
    }
    this.items[index] = value;
    return evicted;
  }
}
