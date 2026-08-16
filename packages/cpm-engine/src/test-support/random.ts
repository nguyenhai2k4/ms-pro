import { at } from '../invariant.js';

/**
 * Seeded pseudo-randomness for the test suite.
 *
 * `Math.random` is a lint error in this package and would be the wrong tool anyway: a determinism
 * test that fails on one run in a thousand, with an input nobody can reproduce, is worse than no
 * test. Everything "random" in these tests is a pure function of an integer seed written into the
 * test file, so a failure reproduces exactly from the test output alone.
 *
 * `mulberry32` — 32-bit state, uniform enough for shuffling, and short enough to read.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy. The input array is never touched. */
export function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = at(copy, i);
    const b = at(copy, j);
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}
