import type {
  CreateDependencyRequest,
  Dependency,
  DependencyType,
  Task,
} from '@projectapp/shared-types';
import { dependencyTypeSchema } from '@projectapp/shared-types';

/**
 * The compact predecessor syntax (FR-SCH-01, FR-SCH-02) used to read and write dependency links
 * inline in the WBS grid — `PredecessorsCell.tsx` is the only consumer. Kept pure and separate
 * from the cell component so parsing/formatting can be unit-tested without React or a mocked
 * `ApiClient`, and so the grammar and the display-unit decision are documented in exactly one
 * place.
 *
 * ## Grammar (EBNF-ish)
 *
 * ```
 * token      := identifier type? lag?
 * identifier := digit+ ( '.' digit+ )*      // a task's wbsCode, e.g. "12" or "1.2.3"
 * type       := 'FS' | 'SS' | 'FF' | 'SF'   // case-insensitive; defaults to 'FS' if omitted
 * lag        := sign magnitude unit?
 * sign       := '+' | '-'
 * magnitude  := digit+ ( '.' digit+ )?
 * unit       := 'd' | 'h'                   // case-insensitive; defaults to 'd' if omitted
 * ```
 *
 * Examples the tech-lead brief names explicitly: `12FS+2d`, `7SS`, `3FF-1d`, `9SF`. A bare `12`
 * (no type, no lag) is also accepted and means `12FS` with zero lag — the common case of "starts
 * after this one finishes" should not require typing the type out.
 *
 * Whitespace between the three parts is tolerated (`12 FS +2d`) but not required.
 *
 * ## Display unit (round-trip is exact)
 *
 * `lagHours` is stored in hours on the wire. Showing raw hours for every lag (`+16h` instead of
 * `+2d`) is technically correct but reads worse than the day-based syntax the brief's own examples
 * use, so the *display* side prefers days: a lag that divides evenly by `WORKING_DAY_HOURS` (8 —
 * a plain assumption, not calendar-aware; there is no per-task/per-calendar "hours per day" in the
 * data model yet, see `apps/web/src/calendars`) is shown in days, and anything that does not
 * divide evenly (an odd number of hours, e.g. a 3-hour lag) is shown in hours instead. Either way
 * the number printed is exactly what `parsePredecessorToken` reads back — a day count divides
 * evenly by construction, and an hour count is never rescaled — so
 * `parsePredecessorToken(formatPredecessorToken(dep, tasks), tasks)` round-trips to the same
 * `lagHours` (see `dependency-syntax.test.ts`, "round-trips").
 */

export const WORKING_DAY_HOURS = 8;

export interface ParsedPredecessorToken {
  readonly predecessorId: Task['id'];
  readonly type: DependencyType;
  readonly lagHours: number;
}

export type ParsePredecessorResult =
  | { readonly ok: true; readonly value: ParsedPredecessorToken }
  | { readonly ok: false; readonly error: string };

const IDENTIFIER_PATTERN = /^[0-9]+(?:\.[0-9]+)*/;
const LAG_PATTERN = /^([+-])\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]*)$/;

/**
 * Parses the compact syntax above against the tasks known to the current project, resolving the
 * leading identifier by `wbsCode` (never by opaque id — nobody types a uuid). Never throws: every
 * failure comes back as `{ ok: false, error }` so a caller can show it inline and skip the API
 * call, per the brief's "malformed input issues no API request" requirement.
 */
export function parsePredecessorToken(
  rawInput: string,
  tasks: readonly Task[],
): ParsePredecessorResult {
  const input = rawInput.trim();
  if (input.length === 0) {
    return { ok: false, error: 'Enter a predecessor, e.g. 12FS+2d.' };
  }

  const identifierMatch = IDENTIFIER_PATTERN.exec(input);
  if (identifierMatch === null) {
    return {
      ok: false,
      error: `"${rawInput}" does not start with a task's WBS code (expected something like 12FS+2d).`,
    };
  }
  const identifier = identifierMatch[0];
  let rest = input.slice(identifier.length).trim();

  let type: DependencyType = 'FS';
  const typeMatch = /^[A-Za-z]{2}/.exec(rest);
  if (typeMatch !== null) {
    const candidate = typeMatch[0].toUpperCase();
    const parsedType = dependencyTypeSchema.safeParse(candidate);
    if (!parsedType.success) {
      return {
        ok: false,
        error: `"${typeMatch[0]}" is not a dependency type — use FS, SS, FF, or SF.`,
      };
    }
    type = parsedType.data;
    rest = rest.slice(typeMatch[0].length).trim();
  }

  let lagHours = 0;
  if (rest.length > 0) {
    const lagMatch = LAG_PATTERN.exec(rest);
    if (lagMatch === null) {
      return {
        ok: false,
        error: `"${rest}" is not a lag — expected something like +2d or -4h.`,
      };
    }
    // Non-null: `LAG_PATTERN`'s first two groups are mandatory (sign, magnitude) and `lagMatch`
    // only reaches here as a successful match; `noUncheckedIndexedAccess` cannot see that from the
    // regex alone, so the fallbacks below are unreachable rather than meaningful defaults.
    const sign = lagMatch[1] ?? '+';
    const magnitudeText = lagMatch[2] ?? '0';
    const unitText = lagMatch[3] ?? '';
    const unit = unitText.toLowerCase();
    if (unit !== '' && unit !== 'd' && unit !== 'h') {
      return { ok: false, error: `"${unitText}" is not a lag unit — use d (days) or h (hours).` };
    }
    const magnitude = Number(magnitudeText);
    const hours = unit === 'h' ? magnitude : magnitude * WORKING_DAY_HOURS;
    lagHours = sign === '-' ? -hours : hours;
  }

  const predecessor = tasks.find((task) => task.wbsCode === identifier);
  if (predecessor === undefined) {
    return { ok: false, error: `No task with WBS code "${identifier}" in this project.` };
  }

  return { ok: true, value: { predecessorId: predecessor.id, type, lagHours } };
}

/** Signed lag as compact text — `''` for no lag, matching the brief's `7SS`/`9SF` examples. */
export function formatLag(lagHours: number): string {
  if (lagHours === 0) return '';
  const sign = lagHours > 0 ? '+' : '-';
  const magnitude = Math.abs(lagHours);
  if (magnitude % WORKING_DAY_HOURS === 0) {
    return `${sign}${magnitude / WORKING_DAY_HOURS}d`;
  }
  return `${sign}${magnitude}h`;
}

/**
 * The read-side compact token for one dependency, e.g. `12FS+2d`. `tasks` resolves the
 * predecessor's `wbsCode`; if the predecessor is somehow absent from the list handed in (it
 * should never be — `listTasks` and `listDependencies` are both project-scoped) the raw id is
 * shown rather than silently dropping the row.
 */
export function formatPredecessorToken(dependency: Dependency, tasks: readonly Task[]): string {
  const predecessor = tasks.find((task) => task.id === dependency.predecessorId);
  const identifier = predecessor?.wbsCode ?? dependency.predecessorId;
  return `${identifier}${dependency.type}${formatLag(dependency.lagHours)}`;
}

/** Builds the exact `CreateDependencyRequest` body for a parsed token against one successor task. */
export function toCreateDependencyRequest(
  parsed: ParsedPredecessorToken,
  successorId: Task['id'],
): CreateDependencyRequest {
  return {
    predecessorId: parsed.predecessorId,
    successorId,
    type: parsed.type,
    lagHours: parsed.lagHours,
  };
}
