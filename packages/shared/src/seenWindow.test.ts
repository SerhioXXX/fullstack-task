import { describe, expect, it } from 'vitest';
import { SeenWindow } from './seenWindow.ts';

describe('SeenWindow', () => {
  it('tells seen from unseen below the highest mark', () => {
    const w = new SeenWindow(8);
    expect(w.check(0)).toBe('unseen');
    w.mark(3);
    w.mark(5);
    expect(w.check(3)).toBe('seen');
    expect(w.check(4)).toBe('unseen');
    expect(w.check(5)).toBe('seen');
    expect(w.check(6)).toBe('unseen');
    expect(w.highestSeq).toBe(5);
  });

  it('keeps exactly `size` values: the one at highest - size is too old', () => {
    const w = new SeenWindow(8);
    w.mark(10);
    expect(w.check(2)).toBe('too_old');
    expect(w.check(3)).toBe('unseen');
    // Marking a too-old value must not overwrite the slot it shares with a live one.
    w.mark(2);
    expect(w.check(10)).toBe('seen');
  });

  it('forgets slots reused after the window slides', () => {
    const w = new SeenWindow(8);
    w.mark(1);
    w.mark(6);
    w.mark(9); // reuses slot of 1 and clears the skipped 7, 8
    expect(w.check(1)).toBe('too_old');
    expect(w.check(6)).toBe('seen');
    expect(w.check(7)).toBe('unseen');
    expect(w.check(8)).toBe('unseen');
  });

  it('clears everything on a jump larger than the window', () => {
    const w = new SeenWindow(8);
    for (let s = 0; s < 8; s++) w.mark(s);
    w.mark(100);
    for (let s = 93; s < 100; s++) expect(w.check(s)).toBe('unseen');
    expect(w.check(100)).toBe('seen');
  });

  it('stays bounded over a long stream with late and duplicate values', () => {
    const w = new SeenWindow(64);
    for (let s = 0; s < 10_000; s++) {
      w.mark(s);
      if (s >= 10) {
        expect(w.check(s - 10)).toBe('seen');
        expect(w.check(s - 64)).toBe('too_old');
      }
    }
  });

  it('rejects a non-positive or fractional size', () => {
    expect(() => new SeenWindow(0)).toThrow();
    expect(() => new SeenWindow(1.5)).toThrow();
  });
});
