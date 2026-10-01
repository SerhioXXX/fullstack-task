export type SeenResult = 'seen' | 'unseen' | 'too_old';

/**
 * Sliding bitmap of the last `size` sequence numbers below the highest one marked.
 * Tells a duplicate apart from a late-but-new message in O(1) and bounded memory.
 */
export class SeenWindow {
  private readonly bits: Uint8Array;
  private highest = -1;

  constructor(readonly size = 1024) {
    if (size <= 0 || !Number.isInteger(size)) throw new Error('SeenWindow size must be a positive integer');
    this.bits = new Uint8Array(size);
  }

  get highestSeq(): number {
    return this.highest;
  }

  check(seq: number): SeenResult {
    if (seq > this.highest) return 'unseen';
    if (seq <= this.highest - this.size) return 'too_old';
    return this.bits[seq % this.size] ? 'seen' : 'unseen';
  }

  mark(seq: number): void {
    if (seq > this.highest) {
      const advance = seq - this.highest;
      if (advance >= this.size) {
        this.bits.fill(0);
      } else {
        for (let s = this.highest + 1; s < seq; s++) this.bits[s % this.size] = 0;
      }
      this.highest = seq;
    } else if (seq <= this.highest - this.size) {
      return;
    }
    this.bits[seq % this.size] = 1;
  }
}
