import type { CpmDependency } from '@projectapp/shared-types';

/**
 * Determinism primitives (CLAUDE.md invariant 1; ADR-010, "Determinism of ordering").
 *
 * "Same input -> byte-identical output" is only meaningful if every ordering decision in the engine
 * is a function of the graph rather than of the order the caller happened to hand us its arrays in.
 * Three rules follow, and every one of them is a real bug someone has shipped before:
 *
 *  1. **Never `localeCompare`.** Its result depends on the host's ICU build and the ambient locale,
 *     so two machines could order the same two task ids differently and each produce a
 *     "byte-identical" schedule that disagrees with the other's. Code-unit comparison via `<` is
 *     total, locale-free and identical on every Node build.
 *  2. **Never rely on sort stability.** `Array.prototype.sort` has been stable since ES2019, but a
 *     stable sort only preserves *input* order for equal keys — which is exactly the input-order
 *     dependence we are trying to eliminate. Every comparator here is therefore a **total** order:
 *     it returns 0 only for values that are indistinguishable, so the input permutation cannot
 *     survive into the output.
 *  3. **Never iterate object keys for order.** Nothing here does; adjacency is arrays sorted with
 *     these comparators, and lookups go through `Map`.
 */

/** Total order on id strings. Code units, not locale. See rule 1 above. */
export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Total order on finite numbers. Kept next to `compareIds` so comparator chains read uniformly. */
export function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Canonical order for a dependency list: ascending by `dependencyId`, which `cpm.ts` names as the
 * canonical order for dependency-keyed arrays.
 *
 * The trailing field comparisons look redundant because ids are unique — and they are, for
 * well-formed input. They are here so the comparator is a *total* order even when the caller hands
 * us two rows sharing an id (a caller bug, reported as a `duplicate_dependency_id` anomaly), rather
 * than silently degrading to "whichever the input listed first" (rule 2 above).
 */
export function compareDependencies(a: CpmDependency, b: CpmDependency): number {
  return (
    compareIds(a.id, b.id) ||
    compareIds(a.predecessorId, b.predecessorId) ||
    compareIds(a.successorId, b.successorId) ||
    compareIds(a.type, b.type) ||
    compareNumbers(a.lagHours, b.lagHours)
  );
}

/**
 * Canonical order for a node's **outgoing** edges: by successor task id, then by dependency id.
 *
 * Successor-first is not arbitrary. The forward pass walks this list, so ordering it by the task
 * being visited next keeps traversal order aligned with the canonical task order, and parallel
 * edges between the same pair of tasks stay adjacent and internally ordered by id.
 */
export function compareOutgoing(a: CpmDependency, b: CpmDependency): number {
  return compareIds(a.successorId, b.successorId) || compareDependencies(a, b);
}

/** Canonical order for a node's **incoming** edges: by predecessor task id, then by dependency id. */
export function compareIncoming(a: CpmDependency, b: CpmDependency): number {
  return compareIds(a.predecessorId, b.predecessorId) || compareDependencies(a, b);
}

/**
 * A binary min-heap over non-negative integers.
 *
 * This exists so the topological sort can always pop the **smallest ready node index** in
 * O(log n) rather than rescanning the frontier in O(n). Node indices are assigned in ascending
 * `taskId` order, so "smallest index" is exactly "smallest task id" — which is the tie-break the
 * canonical ordering contract asks for, at 5k tasks, without an O(n^2) scan.
 *
 * Deliberately typed to `number` rather than made generic: a comparator parameter would be one
 * more place a caller could inject a non-total order and lose determinism.
 */
export class IndexMinHeap {
  readonly #values: number[] = [];

  get size(): number {
    return this.#values.length;
  }

  push(value: number): void {
    const values = this.#values;
    let hole = values.length;
    values.push(value);
    while (hole > 0) {
      const parent = (hole - 1) >> 1;
      const parentValue = values[parent];
      if (parentValue === undefined || parentValue <= value) break;
      values[hole] = parentValue;
      hole = parent;
    }
    values[hole] = value;
  }

  /** Removes and returns the smallest value, or `undefined` when empty. */
  pop(): number | undefined {
    const values = this.#values;
    const smallest = values[0];
    if (smallest === undefined) return undefined;
    const last = values.pop();
    if (last === undefined || values.length === 0) return smallest;

    const size = values.length;
    let hole = 0;
    for (;;) {
      const left = 2 * hole + 1;
      if (left >= size) break;
      const leftValue = values[left];
      if (leftValue === undefined) break;

      const right = left + 1;
      const rightValue = right < size ? values[right] : undefined;
      let child = left;
      let childValue = leftValue;
      if (rightValue !== undefined && rightValue < leftValue) {
        child = right;
        childValue = rightValue;
      }

      if (childValue >= last) break;
      values[hole] = childValue;
      hole = child;
    }
    values[hole] = last;
    return smallest;
  }
}
