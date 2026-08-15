import type { Task } from '@projectapp/shared-types';

/**
 * Pure helpers over the flat, WBS-ordered task list `GET /projects/:id/tasks` returns
 * (FR-TSK-02, FR-VIEW-03). No sorting happens here: `apps/api` orders by
 * `string_to_array(wbs_code, '.')::int[]`, which is already a valid pre-order walk of the tree —
 * a parent always precedes its children and a child always precedes its own children. Indentation
 * depth alone turns that ordering into a tree; re-deriving parent/child order client-side would
 * risk disagreeing with the server's WBS numbering, which `TaskTree` is told not to do.
 */

/** Indentation depth from the WBS code's dot-depth: `"1"` -> 0, `"1.2"` -> 1, `"1.2.3"` -> 2. */
export function wbsDepth(wbsCode: string): number {
  return wbsCode.split('.').length - 1;
}

/** Task id -> number of direct children, derived from `parentId` alone. */
export function buildChildCounts(tasks: readonly Task[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    counts.set(task.parentId, (counts.get(task.parentId) ?? 0) + 1);
  }
  return counts;
}

/**
 * `taskId` and every id below it in the tree. Used to keep a "move to" target list from offering
 * a task's own subtree (FR-TSK-02: a task cannot be moved under its own descendant) — the server
 * rejects that move too, but a client that never offers it is a better experience than one that
 * lets the user pick it and then explains why not.
 */
export function descendantIds(tasks: readonly Task[], taskId: string): ReadonlySet<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const existing = childrenByParent.get(task.parentId);
    if (existing === undefined) childrenByParent.set(task.parentId, [task.id]);
    else existing.push(task.id);
  }

  const result = new Set<string>([taskId]);
  const stack = [taskId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const childId of childrenByParent.get(current) ?? []) {
      if (!result.has(childId)) {
        result.add(childId);
        stack.push(childId);
      }
    }
  }
  return result;
}
