import { describe, expect, it } from 'vitest';
import { rollupFromChildren } from './rollup.js';

/**
 * FR-TSK-03 / FR-TRK-04 at the unit level. The route-level suite (`../tasks.test.ts`) proves the
 * rollup reaches the database and the audit log; this file pins the arithmetic itself, where the
 * expensive mistakes are — a wrong weighting here corrupts every parent task in the product and
 * does it silently, which is why the module is routed at tier O (docs/MODEL-ROUTING.md guardrail 1).
 */

const child = (start: string, finish: string, durationHours: number, pctComplete: number) => ({
  start,
  finish,
  durationHours,
  pctComplete,
});

describe('FR-TSK-03: parent dates span their children', () => {
  it('takes min(start) and max(finish), not the first or last child', () => {
    const rolled = rollupFromChildren([
      child('2026-09-10T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 48, 0),
      child('2026-09-08T00:00:00.000Z', '2026-09-09T00:00:00.000Z', 24, 0),
      child('2026-09-11T00:00:00.000Z', '2026-09-20T00:00:00.000Z', 216, 0),
    ]);

    expect(rolled.start).toBe('2026-09-08T00:00:00.000Z');
    expect(rolled.finish).toBe('2026-09-20T00:00:00.000Z');
  });

  it('derives duration from the wall-clock span, not from the sum of child durations', () => {
    // Two overlapping 24h children spanning 36h. Summing would give 48.
    const rolled = rollupFromChildren([
      child('2026-09-08T00:00:00.000Z', '2026-09-09T00:00:00.000Z', 24, 0),
      child('2026-09-08T12:00:00.000Z', '2026-09-09T12:00:00.000Z', 24, 0),
    ]);

    expect(rolled.durationHours).toBe(36);
  });
});

describe('FR-TRK-04: % complete is duration-weighted', () => {
  it('weights by each child duration, which a plain average would get wrong', () => {
    // Plain average = 50. Duration-weighted = (100*10 + 0*30) / 40 = 25.
    const rolled = rollupFromChildren([
      child('2026-09-08T00:00:00.000Z', '2026-09-08T10:00:00.000Z', 10, 100),
      child('2026-09-08T00:00:00.000Z', '2026-09-09T06:00:00.000Z', 30, 0),
    ]);

    expect(rolled.pctComplete).toBe(25);
  });

  it('falls back to a plain mean when every child has zero duration (all milestones)', () => {
    const rolled = rollupFromChildren([
      child('2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z', 0, 100),
      child('2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z', 0, 0),
    ]);

    expect(rolled.pctComplete).toBe(50);
    expect(Number.isNaN(rolled.pctComplete)).toBe(false);
    expect(rolled.durationHours).toBe(24);
  });

  it('refuses to roll up nothing — a childless task is a leaf, never a summary', () => {
    expect(() => rollupFromChildren([])).toThrow();
  });
});
