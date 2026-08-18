import { describe, expect, it } from 'vitest';
import {
  formatLag,
  formatPredecessorToken,
  parsePredecessorToken,
  toCreateDependencyRequest,
  WORKING_DAY_HOURS,
} from './dependency-syntax.js';
import { makeDependency, makeTask } from './test-support.jsx';

/**
 * FR-SCH-01, FR-SCH-02, FR-SCH-03. Pure-function tests for the grammar documented at the top of
 * `dependency-syntax.ts` — no React, no mocked `ApiClient`.
 */

const target = makeTask({ id: 'target', wbsCode: '1', name: 'Design' });
const pred12 = makeTask({ id: 'pred12', wbsCode: '12', name: 'Site survey' });
const pred7 = makeTask({ id: 'pred7', wbsCode: '7', name: 'Permits' });
const pred3 = makeTask({ id: 'pred3', wbsCode: '3', name: 'Excavation' });
const pred9 = makeTask({ id: 'pred9', wbsCode: '9', name: 'Utilities' });
const nested = makeTask({ id: 'nested', wbsCode: '1.2.3', name: 'Sub-sub-task' });

const tasks = [target, pred12, pred7, pred3, pred9, nested];

describe("parsePredecessorToken (the tech-lead brief's four acceptance examples)", () => {
  it('parses "12FS+2d" as task 12, FS, +2 working days of lag', () => {
    const result = parsePredecessorToken('12FS+2d', tasks);
    expect(result).toEqual({
      ok: true,
      value: { predecessorId: 'pred12', type: 'FS', lagHours: 2 * WORKING_DAY_HOURS },
    });
  });

  it('parses "7SS" as task 7, SS, no lag', () => {
    const result = parsePredecessorToken('7SS', tasks);
    expect(result).toEqual({
      ok: true,
      value: { predecessorId: 'pred7', type: 'SS', lagHours: 0 },
    });
  });

  it('parses "3FF-1d" as task 3, FF, -1 working day of lag', () => {
    const result = parsePredecessorToken('3FF-1d', tasks);
    expect(result).toEqual({
      ok: true,
      value: { predecessorId: 'pred3', type: 'FF', lagHours: -1 * WORKING_DAY_HOURS },
    });
  });

  it('parses "9SF" as task 9, SF, no lag', () => {
    const result = parsePredecessorToken('9SF', tasks);
    expect(result).toEqual({
      ok: true,
      value: { predecessorId: 'pred9', type: 'SF', lagHours: 0 },
    });
  });

  it('defaults a bare task reference to FS with no lag', () => {
    const result = parsePredecessorToken('12', tasks);
    expect(result).toEqual({
      ok: true,
      value: { predecessorId: 'pred12', type: 'FS', lagHours: 0 },
    });
  });

  it('accepts a dotted WBS code as the identifier', () => {
    const result = parsePredecessorToken('1.2.3SS', tasks);
    expect(result).toEqual({
      ok: true,
      value: { predecessorId: 'nested', type: 'SS', lagHours: 0 },
    });
  });

  it('accepts an explicit hour lag and a lower-case type', () => {
    const result = parsePredecessorToken('12fs+4h', tasks);
    expect(result).toEqual({
      ok: true,
      value: { predecessorId: 'pred12', type: 'FS', lagHours: 4 },
    });
  });

  it('tolerates whitespace between the parts', () => {
    const result = parsePredecessorToken('12 FS +2d', tasks);
    expect(result).toEqual({
      ok: true,
      value: { predecessorId: 'pred12', type: 'FS', lagHours: 2 * WORKING_DAY_HOURS },
    });
  });
});

describe('parsePredecessorToken rejects malformed input without guessing', () => {
  it('rejects empty input', () => {
    const result = parsePredecessorToken('', tasks);
    expect(result.ok).toBe(false);
  });

  it('rejects a task reference that resolves to nothing in the project', () => {
    const result = parsePredecessorToken('999FS', tasks);
    expect(result).toEqual({ ok: false, error: expect.stringContaining('999') });
  });

  it('rejects an unknown two-letter type', () => {
    const result = parsePredecessorToken('12XY', tasks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('XY');
  });

  it('rejects an unparseable lag', () => {
    const result = parsePredecessorToken('12FS+abc', tasks);
    expect(result.ok).toBe(false);
  });

  it('rejects a lag with a sign but no magnitude', () => {
    const result = parsePredecessorToken('12FS+', tasks);
    expect(result.ok).toBe(false);
  });

  it('rejects garbage text outright', () => {
    const result = parsePredecessorToken('not a dependency', tasks);
    expect(result.ok).toBe(false);
  });
});

describe('formatLag', () => {
  it('shows no text for zero lag', () => {
    expect(formatLag(0)).toBe('');
  });

  it('shows a lag that divides evenly by the working day in days', () => {
    expect(formatLag(16)).toBe('+2d');
    expect(formatLag(-8)).toBe('-1d');
  });

  it('shows a lag that does not divide evenly by the working day in hours', () => {
    expect(formatLag(3)).toBe('+3h');
    expect(formatLag(-5)).toBe('-5h');
  });
});

describe('round-trip: parse(format(x)) === x for every lagHours', () => {
  it.each([0, 8, 16, -8, -16, 3, -5, 12, 1, 800])('round-trips %i hours', (lagHours) => {
    const dependency = makeDependency({
      predecessorId: 'pred12',
      successorId: 'target',
      type: 'SS',
      lagHours,
    });
    const token = formatPredecessorToken(dependency, tasks);
    const parsed = parsePredecessorToken(token, tasks);
    expect(parsed).toEqual({
      ok: true,
      value: { predecessorId: 'pred12', type: 'SS', lagHours },
    });
  });
});

describe('formatPredecessorToken', () => {
  it("renders the brief's own example", () => {
    const dependency = makeDependency({
      predecessorId: 'pred12',
      successorId: 'target',
      type: 'FS',
      lagHours: 16,
    });
    expect(formatPredecessorToken(dependency, tasks)).toBe('12FS+2d');
  });

  it('falls back to the raw id if the predecessor is not in the task list handed in', () => {
    const dependency = makeDependency({
      predecessorId: 'missing-task-id',
      successorId: 'target',
      type: 'FS',
      lagHours: 0,
    });
    expect(formatPredecessorToken(dependency, tasks)).toBe('missing-task-idFS');
  });
});

describe('toCreateDependencyRequest', () => {
  it('builds the exact request body from a parsed token', () => {
    const parsed = parsePredecessorToken('12FS+2d', tasks);
    if (!parsed.ok) throw new Error('expected a successful parse');
    expect(toCreateDependencyRequest(parsed.value, target.id)).toEqual({
      predecessorId: 'pred12',
      successorId: 'target',
      type: 'FS',
      lagHours: 16,
    });
  });
});
