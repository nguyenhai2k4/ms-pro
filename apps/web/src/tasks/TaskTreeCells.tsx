import type {
  CreateDependencyRequest,
  DeleteTaskChildPolicy,
  Dependency,
  Task,
  UpdateDependencyRequest,
  UpdateTaskRequest,
} from '@projectapp/shared-types';
import { taskStatusSchema } from '@projectapp/shared-types';
import { useState } from 'react';
import { descendantIds } from './task-hierarchy.js';

/**
 * Per-cell editors for `TaskTree`. Split out of `TaskTree.tsx` so the table shell (columns,
 * TanStack Table wiring) stays readable next to the per-field editing rules, which is where all
 * of FR-TSK-01..09's field-level nuance actually lives.
 *
 * Every cell here draws the same distinction: a read-only role (Contributor or Viewer, P1 — see
 * `TaskTree.tsx`) never renders an `<input>`/`<select>`/button at all, only text. Hiding the
 * control is not access control (CLAUDE.md invariant 3; the server enforces RBAC independently),
 * but a disabled control is still a dangling affordance that implies "you could do this if
 * only," which is worse than not showing it.
 */

export interface TaskTreeMeta {
  readonly canEdit: boolean;
  /** Task id -> direct child count, so a summary task's rollup-owned fields can be disabled. */
  readonly childCounts: ReadonlyMap<string, number>;
  readonly allTasks: readonly Task[];
  readonly onUpdate: (taskId: Task['id'], patch: UpdateTaskRequest) => void;
  readonly onAddChild: (parentId: Task['id'], name: string) => void;
  readonly onDelete: (taskId: Task['id'], childPolicy?: DeleteTaskChildPolicy) => void;
  readonly onReparent: (taskId: Task['id'], newParentId: Task['id'] | null) => void;
  /**
   * FR-SCH-01..03: every dependency link in the project, unfiltered — `PredecessorsCell` selects
   * the ones pointing at its own task. Unlike the callbacks above, the three dependency mutations
   * return a `Promise` rather than firing-and-forgetting: `PredecessorsCell` awaits its own call so
   * a `409 dependency_cycle` can be rendered inline (task names, not ids) and the field reverted,
   * instead of only surfacing through this tree's shared error banner.
   */
  readonly dependencies: readonly Dependency[];
  readonly onCreateDependency: (body: CreateDependencyRequest) => Promise<Dependency>;
  readonly onUpdateDependency: (
    dependencyId: Dependency['id'],
    patch: UpdateDependencyRequest,
  ) => Promise<Dependency>;
  readonly onDeleteDependency: (dependencyId: Dependency['id']) => Promise<void>;
}

const STATUS_LABELS: Record<Task['status'], string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};

const toDateInputValue = (iso: string): string => iso.slice(0, 10);
const fromDateInputValue = (value: string): string =>
  new Date(`${value}T08:00:00.000Z`).toISOString();
const formatDate = (iso: string): string => new Date(iso).toLocaleDateString('en-GB');

function hasChildren(task: Task, meta: TaskTreeMeta): boolean {
  return (meta.childCounts.get(task.id) ?? 0) > 0;
}

interface CellProps {
  readonly task: Task;
  readonly meta: TaskTreeMeta;
}

/** FR-TSK-04: a milestone is marked by an icon plus text, never colour alone (WCAG 1.4.1). */
export function MilestoneBadge(): JSX.Element {
  return (
    <span className="task-tree__milestone-badge">
      <span aria-hidden="true">◆</span>
      <span> Milestone</span>
    </span>
  );
}

export function NameCell({ task, meta, depth }: CellProps & { depth: number }): JSX.Element {
  const [draft, setDraft] = useState(task.name);
  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== task.name) meta.onUpdate(task.id, { name: trimmed });
    else setDraft(task.name);
  };

  return (
    <div className="task-tree__name-cell" style={{ paddingLeft: `${depth * 1.5}rem` }}>
      {meta.canEdit ? (
        <input
          aria-label={`Name for ${task.wbsCode}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
      ) : (
        <span>{task.name}</span>
      )}
      {task.isMilestone ? <MilestoneBadge /> : null}
    </div>
  );
}

export function DurationCell({ task, meta }: CellProps): JSX.Element {
  const disabled = hasChildren(task, meta);
  const [draft, setDraft] = useState(String(task.durationHours));
  const noteId = `duration-note-${task.id}`;

  if (!meta.canEdit) return <span>{task.durationHours}h</span>;

  const commit = (): void => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed !== task.durationHours) {
      meta.onUpdate(task.id, { durationHours: parsed });
    } else {
      setDraft(String(task.durationHours));
    }
  };

  return (
    <div>
      <input
        aria-label={`Duration in hours for ${task.wbsCode} ${task.name}`}
        aria-describedby={disabled ? noteId : undefined}
        type="number"
        min={0}
        step={0.5}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
      {disabled ? (
        <p id={noteId} className="task-tree__field-note">
          Rolls up from children (FR-TSK-03) — edit a leaf task instead.
        </p>
      ) : null}
    </div>
  );
}

export function StartCell({ task, meta }: CellProps): JSX.Element {
  const rollsUp = hasChildren(task, meta);
  const manual = task.scheduleMode === 'manual';
  const disabled = rollsUp || !manual;
  const [draft, setDraft] = useState(toDateInputValue(task.start));
  const noteId = `start-note-${task.id}`;

  if (!meta.canEdit) return <span>{formatDate(task.start)}</span>;

  const commit = (): void => {
    if (draft.length === 0) return;
    const iso = fromDateInputValue(draft);
    if (iso !== task.start) meta.onUpdate(task.id, { start: iso });
  };

  const note = rollsUp
    ? 'Rolls up from children (FR-TSK-03) — edit a leaf task instead.'
    : !manual
      ? 'Only editable when scheduling mode is Manual (FR-TSK-05); this task is Auto-scheduled.'
      : null;

  return (
    <div>
      <input
        aria-label={`Start date for ${task.wbsCode} ${task.name}`}
        aria-describedby={note !== null ? noteId : undefined}
        type="date"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
      {note !== null ? (
        <p id={noteId} className="task-tree__field-note">
          {note}
        </p>
      ) : null}
    </div>
  );
}

/** Finish is always server-computed (FR-TSK-03/FR-SCH-07) — never a direct edit target. */
export function FinishCell({ task }: { task: Task }): JSX.Element {
  return <span>{formatDate(task.finish)}</span>;
}

export function PctCompleteCell({ task, meta }: CellProps): JSX.Element {
  const disabled = hasChildren(task, meta);
  const [draft, setDraft] = useState(String(task.pctComplete));
  const noteId = `pct-note-${task.id}`;

  if (!meta.canEdit) return <span>{Math.round(task.pctComplete)}%</span>;

  const commit = (): void => {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 && parsed !== task.pctComplete) {
      meta.onUpdate(task.id, { pctComplete: parsed });
    } else {
      setDraft(String(task.pctComplete));
    }
  };

  return (
    <div>
      <input
        aria-label={`Percent complete for ${task.wbsCode} ${task.name}`}
        aria-describedby={disabled ? noteId : undefined}
        type="number"
        min={0}
        max={100}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
      {disabled ? (
        <p id={noteId} className="task-tree__field-note">
          Rolls up from children (FR-TSK-03) — edit a leaf task instead.
        </p>
      ) : null}
    </div>
  );
}

export function MilestoneCell({ task, meta }: CellProps): JSX.Element {
  const disabled = hasChildren(task, meta);
  const noteId = `milestone-note-${task.id}`;

  if (!meta.canEdit) return <span>{task.isMilestone ? 'Yes' : 'No'}</span>;

  const onChange = (checked: boolean): void => {
    // FR-TSK-04: a milestone is duration 0. Sending both fields together avoids a round trip
    // that would 422 on `taskInvariantsSchema`'s "milestone implies durationHours === 0" rule.
    meta.onUpdate(
      task.id,
      checked ? { isMilestone: true, durationHours: 0 } : { isMilestone: false },
    );
  };

  return (
    <div>
      <label>
        <input
          type="checkbox"
          checked={task.isMilestone}
          disabled={disabled}
          aria-describedby={disabled ? noteId : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        {' Milestone'}
      </label>
      {disabled ? (
        <p id={noteId} className="task-tree__field-note">
          A milestone cannot have children (FR-TSK-04).
        </p>
      ) : null}
    </div>
  );
}

export function PriorityCell({ task, meta }: CellProps): JSX.Element {
  const [draft, setDraft] = useState(String(task.priority));

  if (!meta.canEdit) return <span>{task.priority}</span>;

  const commit = (): void => {
    const parsed = Number(draft);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000 && parsed !== task.priority) {
      meta.onUpdate(task.id, { priority: parsed });
    } else {
      setDraft(String(task.priority));
    }
  };

  return (
    <input
      aria-label={`Priority for ${task.wbsCode} ${task.name}`}
      type="number"
      min={0}
      max={1000}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
    />
  );
}

export function StatusCell({ task, meta }: CellProps): JSX.Element {
  if (!meta.canEdit) return <span>{STATUS_LABELS[task.status]}</span>;

  return (
    <select
      aria-label={`Status for ${task.wbsCode} ${task.name}`}
      value={task.status}
      onChange={(event) => meta.onUpdate(task.id, { status: event.target.value as Task['status'] })}
    >
      {taskStatusSchema.options.map((status) => (
        <option key={status} value={status}>
          {STATUS_LABELS[status]}
        </option>
      ))}
    </select>
  );
}

export function NotesCell({ task, meta }: CellProps): JSX.Element {
  const [draft, setDraft] = useState(task.notes);

  if (!meta.canEdit) return <span>{task.notes}</span>;

  const commit = (): void => {
    if (draft !== task.notes) meta.onUpdate(task.id, { notes: draft });
  };

  return (
    <input
      aria-label={`Notes for ${task.wbsCode} ${task.name}`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
    />
  );
}

type Panel = 'none' | 'addChild' | 'move' | 'delete';

export function ActionsCell({ task, meta }: CellProps): JSX.Element {
  const [panel, setPanel] = useState<Panel>('none');
  const [childName, setChildName] = useState('');
  const [moveTarget, setMoveTarget] = useState('');

  const childCount = meta.childCounts.get(task.id) ?? 0;
  const excluded = descendantIds(meta.allTasks, task.id);
  const moveCandidates = meta.allTasks.filter((candidate) => !excluded.has(candidate.id));
  const parentTask =
    task.parentId === null ? null : meta.allTasks.find((t) => t.id === task.parentId);

  if (panel === 'addChild') {
    return (
      <form
        aria-label={`Add a sub-task under ${task.name}`}
        onSubmit={(event) => {
          event.preventDefault();
          meta.onAddChild(task.id, childName);
          setChildName('');
          setPanel('none');
        }}
      >
        <label htmlFor={`add-child-${task.id}`}>New sub-task name</label>
        <input
          id={`add-child-${task.id}`}
          value={childName}
          onChange={(event) => setChildName(event.target.value)}
          required
          autoFocus
        />
        <button type="submit">Add</button>
        <button type="button" onClick={() => setPanel('none')}>
          Cancel
        </button>
      </form>
    );
  }

  if (panel === 'move') {
    return (
      <div role="group" aria-label={`Move ${task.name} to a new parent`}>
        <label htmlFor={`move-${task.id}`}>Move to</label>
        <select
          id={`move-${task.id}`}
          value={moveTarget}
          onChange={(event) => setMoveTarget(event.target.value)}
        >
          <option value="">Top level</option>
          {moveCandidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.wbsCode} {candidate.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            // `moveTarget` comes off a plain HTML <select>'s string value; the option list
            // (`moveCandidates`) is built from real `Task['id']`s, so this is a narrow, safe
            // widen back to the branded id type rather than an escape hatch.
            meta.onReparent(task.id, moveTarget === '' ? null : (moveTarget as Task['id']));
            setPanel('none');
          }}
        >
          Move
        </button>
        <button type="button" onClick={() => setPanel('none')}>
          Cancel
        </button>
      </div>
    );
  }

  if (panel === 'delete') {
    if (childCount > 0) {
      return (
        <div role="group" aria-label={`Delete ${task.name}, which has sub-tasks`}>
          <p>
            {task.name} has {childCount} sub-task{childCount === 1 ? '' : 's'}. Choose what happens
            to them (FR-TSK-08).
          </p>
          <button
            type="button"
            onClick={() => {
              meta.onDelete(task.id, 'cascade');
              setPanel('none');
            }}
          >
            Delete them too
          </button>
          <button
            type="button"
            onClick={() => {
              meta.onDelete(task.id, 'reparentToGrandparent');
              setPanel('none');
            }}
          >
            Move them to{' '}
            {parentTask === undefined || parentTask === null ? 'top level' : parentTask.name}
          </button>
          <button type="button" onClick={() => setPanel('none')}>
            Cancel
          </button>
        </div>
      );
    }
    return (
      <div role="group" aria-label={`Delete ${task.name}`}>
        <p>Delete &ldquo;{task.name}&rdquo;? This cannot be undone.</p>
        <button
          type="button"
          onClick={() => {
            meta.onDelete(task.id);
            setPanel('none');
          }}
        >
          Delete
        </button>
        <button type="button" onClick={() => setPanel('none')}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="task-tree__actions">
      <button
        type="button"
        onClick={() => setPanel('addChild')}
        disabled={task.isMilestone}
        title={task.isMilestone ? 'A milestone cannot have children (FR-TSK-04)' : undefined}
      >
        Add child
      </button>
      <button type="button" onClick={() => setPanel('move')}>
        Move to…
      </button>
      <button type="button" onClick={() => setPanel('delete')}>
        Delete
      </button>
    </div>
  );
}
