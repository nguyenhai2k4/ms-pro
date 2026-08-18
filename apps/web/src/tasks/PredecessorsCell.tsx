import type { Dependency, Task } from '@projectapp/shared-types';
import { dependencyCycleDetailsSchema } from '@projectapp/shared-types';
import { useState } from 'react';
import { ApiRequestError } from '../api/client.js';
import {
  formatPredecessorToken,
  parsePredecessorToken,
  toCreateDependencyRequest,
} from './dependency-syntax.js';
import type { TaskTreeMeta } from './TaskTreeCells.jsx';

/**
 * The predecessor column (FR-SCH-01, FR-SCH-02, FR-SCH-03, FR-VIEW-03): reads and writes
 * dependency links inline in the WBS grid, in the compact syntax documented in
 * `dependency-syntax.ts`.
 *
 * Split out of `TaskTreeCells.tsx` rather than added there because this cell, unlike every other
 * one in that file, talks to a second entity (`Dependency`) and needs to `await` its own mutation
 * to render a cycle rejection inline and revert the field — the rest of that file's cells fire a
 * mutation and let `TaskTree`'s shared `onError` show a generic banner. Reusing that shared path
 * here would either lose the cycle-specific message the brief asks for, or force every other cell
 * to plumb the same per-field async handling it does not need.
 *
 * Same RBAC split as every other cell in this tree (`meta.canEdit`): a read-only role sees the
 * compact tokens as plain text and nothing else — no input, no button, matching
 * `TaskTree.a11y.test.tsx`'s DOM-absence convention.
 */

interface PredecessorsCellProps {
  readonly task: Task;
  readonly meta: TaskTreeMeta;
}

/** Cycle-specific message when present; otherwise the server's own message, then a generic one. */
function describeDependencyError(error: unknown, tasks: readonly Task[]): string {
  if (error instanceof ApiRequestError && error.error.code === 'dependency_cycle') {
    const parsedDetails = dependencyCycleDetailsSchema.safeParse(error.error.details);
    if (parsedDetails.success) {
      const names = parsedDetails.data.cyclePath.map((taskId) => {
        const named = tasks.find((task) => task.id === taskId);
        return named?.name ?? taskId;
      });
      return `That link would create a cycle: ${names.join(' → ')}`;
    }
    return 'That link would create a cycle.';
  }
  if (error instanceof ApiRequestError) return error.error.message;
  if (error instanceof Error) return error.message;
  return 'That change could not be saved.';
}

function PredecessorEditRow({
  dependency,
  task,
  meta,
  index,
}: {
  readonly dependency: Dependency;
  readonly task: Task;
  readonly meta: TaskTreeMeta;
  readonly index: number;
}): JSX.Element {
  const committed = formatPredecessorToken(dependency, meta.allTasks);
  const [draft, setDraft] = useState(committed);
  const [error, setError] = useState<string | null>(null);
  const label = `Predecessor ${index + 1} for ${task.wbsCode} ${task.name}`;
  const errorId = `predecessor-error-${dependency.id}`;

  const commit = async (): Promise<void> => {
    if (draft === committed) return;

    const parsed = parsePredecessorToken(draft, meta.allTasks);
    if (!parsed.ok) {
      setError(parsed.error);
      setDraft(committed);
      return;
    }
    // The endpoint (which two tasks this link joins) is not editable through `PATCH
    // /dependencies/:id` (`UpdateDependencyRequest` carries only `type`/`lagHours`) — the API
    // contract makes changing it a delete-plus-create instead. Detected here rather than left to
    // a 422 so the message names the actual affordance (the Remove button) instead of a field
    // this input cannot send.
    if (parsed.value.predecessorId !== dependency.predecessorId) {
      setError(
        'Changing which task this depends on is not supported here — remove this link and add a new one instead.',
      );
      setDraft(committed);
      return;
    }
    if (parsed.value.type === dependency.type && parsed.value.lagHours === dependency.lagHours) {
      setError(null);
      return;
    }

    try {
      await meta.onUpdateDependency(dependency.id, {
        type: parsed.value.type,
        lagHours: parsed.value.lagHours,
      });
      setError(null);
    } catch (caught) {
      // FR-COL-02-style honesty: a rejected edit (most notably a 409 cycle) reverts to the value
      // that is actually persisted rather than leaving the draft showing something the server
      // refused, and the message says why.
      setError(describeDependencyError(caught, meta.allTasks));
      setDraft(committed);
    }
  };

  return (
    <div className="task-tree__predecessor-row">
      <input
        aria-label={label}
        aria-describedby={error !== null ? errorId : undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          void commit();
        }}
      />
      <button
        type="button"
        aria-label={`Remove predecessor ${committed} from ${task.wbsCode} ${task.name}`}
        onClick={() => {
          void meta.onDeleteDependency(dependency.id).catch((caught: unknown) => {
            setError(describeDependencyError(caught, meta.allTasks));
          });
        }}
      >
        Remove
      </button>
      {error !== null ? (
        <p id={errorId} role="alert" className="task-tree__field-note">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function AddPredecessorForm({ task, meta }: PredecessorsCellProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = `add-predecessor-${task.id}`;
  const errorId = `add-predecessor-error-${task.id}`;

  const submit = async (): Promise<void> => {
    const parsed = parsePredecessorToken(draft, meta.allTasks);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    try {
      await meta.onCreateDependency(toCreateDependencyRequest(parsed.value, task.id));
      setDraft('');
      setError(null);
    } catch (caught) {
      setError(describeDependencyError(caught, meta.allTasks));
    }
  };

  return (
    <form
      className="task-tree__add-predecessor"
      aria-label={`Add predecessor for ${task.wbsCode} ${task.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId}>Add predecessor</label>
      <input
        id={inputId}
        aria-describedby={error !== null ? errorId : undefined}
        placeholder="e.g. 12FS+2d"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="submit">Add</button>
      {error !== null ? (
        <p id={errorId} role="alert" className="task-tree__field-note">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function PredecessorsCell({ task, meta }: PredecessorsCellProps): JSX.Element {
  const predecessorLinks = meta.dependencies.filter((d) => d.successorId === task.id);

  if (!meta.canEdit) {
    const summary =
      predecessorLinks.length === 0
        ? 'None'
        : predecessorLinks
            .map((dependency) => formatPredecessorToken(dependency, meta.allTasks))
            .join(', ');
    return <span>{summary}</span>;
  }

  return (
    <div className="task-tree__predecessors">
      {predecessorLinks.map((dependency, index) => (
        <PredecessorEditRow
          key={dependency.id}
          dependency={dependency}
          task={task}
          meta={meta}
          index={index}
        />
      ))}
      <AddPredecessorForm task={task} meta={meta} />
    </div>
  );
}
