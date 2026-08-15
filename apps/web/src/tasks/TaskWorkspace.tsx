import type { ProjectRole } from '@projectapp/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { EmptyProjectState } from '../views/EmptyProjectState.jsx';
import { TaskTree } from './TaskTree.jsx';

export interface TaskWorkspaceProps {
  readonly api: ApiClient;
  readonly projectId: string;
  readonly projectName: string;
  readonly role: ProjectRole;
}

const DEFAULT_TASK_DURATION_HOURS = 8;

/**
 * FR-TSK-01..09, FR-VIEW-03, FR-PRJ-07: owns the task list for one project and switches between
 * the empty state and the WBS tree/grid.
 *
 * Empty vs. non-empty is decided from the task list itself, not `ProjectSummary.taskCount` — that
 * count comes from a separate query and would go stale the instant this component creates the
 * first task. Re-deriving the same boolean from two sources is how "empty" and "not empty" get to
 * disagree; the task list this component already fetches is the one source of truth for it.
 *
 * RBAC mirrors `packages/shared-types/src/rbac.ts` (CLAUDE.md invariant 3 — hiding an affordance
 * is UX, not access control, and the server enforces the real check on every write): Admin and
 * Editor get the full create/edit/reparent/delete surface. Contributor holds `task:update:assigned`
 * on paper, but P1 has no assignment mechanism yet (`apps/api/src/routes/tasks.ts`'s
 * `assertAssignedRowLevel`), so a Contributor is refused on every task mutation right now — this
 * view therefore renders Contributor exactly like Viewer: read-only.
 */
export function TaskWorkspace({
  api,
  projectId,
  projectName,
  role,
}: TaskWorkspaceProps): JSX.Element {
  const canEdit = role === 'admin' || role === 'editor';
  const queryClient = useQueryClient();

  const tasksQuery = useQuery({
    queryKey: ['tasks', projectId],
    queryFn: () => api.listTasks(projectId),
  });

  const [isAddingFirstTask, setIsAddingFirstTask] = useState(false);
  const [firstTaskName, setFirstTaskName] = useState('');

  const createFirstTask = useMutation({
    mutationFn: (name: string) =>
      api.createTask(projectId, {
        parentId: null,
        name,
        durationHours: DEFAULT_TASK_DURATION_HOURS,
        start: null,
        isMilestone: false,
        scheduleMode: 'auto',
        constraintType: 'ASAP',
        constraintDate: null,
        calendarId: null,
        priority: 500,
      }),
    onSuccess: async () => {
      setIsAddingFirstTask(false);
      setFirstTaskName('');
      await queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });

  if (tasksQuery.isLoading) return <p>Loading tasks…</p>;
  if (tasksQuery.isError || tasksQuery.data === undefined) {
    return <p role="alert">Could not load tasks for this project.</p>;
  }

  const tasks = tasksQuery.data.tasks;

  if (tasks.length === 0) {
    return (
      <div className="task-workspace task-workspace--empty">
        <EmptyProjectState
          projectName={projectName}
          canEdit={canEdit}
          onAddFirstTask={() => setIsAddingFirstTask(true)}
        />

        {canEdit && isAddingFirstTask ? (
          <form
            className="task-workspace__first-task-form"
            aria-label="Add the first task"
            onSubmit={(event) => {
              event.preventDefault();
              createFirstTask.mutate(firstTaskName);
            }}
          >
            <label htmlFor="first-task-name">Task name</label>
            <input
              id="first-task-name"
              value={firstTaskName}
              onChange={(event) => setFirstTaskName(event.target.value)}
              required
              autoFocus
            />
            <button type="submit" disabled={createFirstTask.isPending}>
              Create task
            </button>
            <button type="button" onClick={() => setIsAddingFirstTask(false)}>
              Cancel
            </button>
          </form>
        ) : null}

        {createFirstTask.isError ? (
          <p role="alert">{(createFirstTask.error as Error).message}</p>
        ) : null}
      </div>
    );
  }

  return <TaskTree api={api} projectId={projectId} tasks={tasks} canEdit={canEdit} />;
}
