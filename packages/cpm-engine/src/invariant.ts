/**
 * Internal invariant helpers.
 *
 * These guard **engine** invariants — an index derived from the very array it indexes, a residual
 * node set that Kahn's algorithm says must contain a cycle. They never guard *caller* data.
 *
 * That distinction is the whole reason this file has a docstring. Malformed input (a dependency
 * naming a task that is not in the graph, a self-link, a calendar that was not passed) is answered
 * with a **diagnostic**, never an exception: an engine that throws on bad input turns a user's
 * mistake into a 500 for whoever called it, and `CpmScheduleResult`'s `rejected` arm exists
 * precisely so that case has a representable, non-throwing answer.
 *
 * Reaching anything in this file therefore means a bug in *this package*, not in the caller's
 * data. That is why it is the one place here that is allowed to throw.
 */

/**
 * Array access that collapses `noUncheckedIndexedAccess`'s `T | undefined` for indices this
 * package derived itself. Not for indices that came from input.
 */
export function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) {
    throw new RangeError(
      `cpm-engine invariant: index ${index} is outside 0..${items.length - 1} (this is an engine bug, not bad input)`,
    );
  }
  return value;
}

/** Asserts an engine invariant. See the file docstring for why this is not input validation. */
export function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`cpm-engine invariant: ${message} (this is an engine bug, not bad input)`);
  }
}
