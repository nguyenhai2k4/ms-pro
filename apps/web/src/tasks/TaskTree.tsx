import type { DeleteTaskChildPolicy, Task, UpdateTaskRequest } from '@projectapp/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { buildChildCounts, wbsDepth } from './task-hierarchy.js';
import {
  ActionsCell,
  DurationCell,
  FinishCell,
  MilestoneCell,
  NameCell,
  NotesCell,
  PctCompleteCell,
  PriorityCell,
  StartCell,
  StatusCell,
  type TaskTreeMeta,
} from './TaskTreeCells.jsx';

/**
 * The WBS tree/grid (FR-TSK-01..09, FR-VIEW-03) built on the plain `Task` entity.
 *
 * Deliberately not `TaskGrid.tsx`: that component is built against `GanttTaskView`
 * (`isCritical`, `totalFloatHours`, `hasScheduleConflict`), and those fields come from the CPM
 * engine, which does not exist until P2. Feeding it stub critical-path data here would put false
 * schedule information in front of the user — this component shows only what the server has
 * actually persisted, and nothing it has not computed.
 *
 * `TaskGrid.tsx`'s accessible-table conventions carry over (semantic `<table>`, `aria-label`,
 * real `<th scope="col">`) but not its sortable-header pattern: the server's WBS ordering
 * (`ORDER BY string_to_array(wbs_code, '.')::int[]`) is the authority on task order (FR-TSK-02),
 * so a client-side re-sort here could show a tree that disagrees with the server's own numbering.
 * Indentation (from `wbsDepth`) is what turns the flat, already-ordered list into a tree.
 *
 * Not virtualized — P1's row counts are small, and FR-VIEW-02's 2,000-row budget is a Gantt/Grid
 * concern for once the CPM engine exists to populate `TaskGrid.tsx` with real data.
 */
export interface TaskTreeProps {
  readonly api: ApiClient;
  readonly projectId: string;
  readonly tasks: readonly Task[];
  readonly canEdit: boolean;
}

const DEFAULT_CHILD_DURATION_HOURS = 8;

const columnHelper = createColumnHelper<Task>();

export function TaskTree({ api, projectId, tasks, canEdit }: TaskTreeProps): JSX.Element {
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // FR-VIEW-07 honesty: this view has no live updates yet (that is P3). A mutation's own response
  // is not hand-patched into local state — the whole list is refetched so rollup side effects on
  // ancestors the caller did not directly edit (FR-TSK-03) show up too, not just the one row that
  // was touched.
  const invalidate = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ['tasks', projectId] }).then(() => undefined);

  const onMutationError = (error: unknown): void => {
    setErrorMessage(error instanceof Error ? error.message : 'That change could not be saved.');
  };
  const onMutationSuccess = async (): Promise<void> => {
    setErrorMessage(null);
    await invalidate();
  };

  const updateTask = useMutation({
    mutationFn: ({ taskId, patch }: { taskId: Task['id']; patch: UpdateTaskRequest }) =>
      api.updateTask(projectId, taskId, patch),
    onSuccess: onMutationSuccess,
    onError: onMutationError,
  });

  const createChild = useMutation({
    mutationFn: ({ parentId, name }: { parentId: Task['id']; name: string }) =>
      api.createTask(projectId, {
        parentId,
        name,
        durationHours: DEFAULT_CHILD_DURATION_HOURS,
        start: null,
        isMilestone: false,
        scheduleMode: 'auto',
        constraintType: 'ASAP',
        constraintDate: null,
        calendarId: null,
        priority: 500,
      }),
    onSuccess: onMutationSuccess,
    onError: onMutationError,
  });

  const reparentTask = useMutation({
    mutationFn: ({ taskId, newParentId }: { taskId: Task['id']; newParentId: Task['id'] | null }) =>
      api.reparentTask(projectId, taskId, { newParentId }),
    onSuccess: onMutationSuccess,
    onError: onMutationError,
  });

  const deleteTask = useMutation({
    mutationFn: ({
      taskId,
      childPolicy,
    }: {
      taskId: Task['id'];
      childPolicy?: DeleteTaskChildPolicy;
    }) =>
      api.deleteTask(projectId, taskId, childPolicy === undefined ? undefined : { childPolicy }),
    onSuccess: onMutationSuccess,
    onError: onMutationError,
  });

  const meta: TaskTreeMeta = useMemo(
    () => ({
      canEdit,
      childCounts: buildChildCounts(tasks),
      allTasks: tasks,
      onUpdate: (taskId, patch) => updateTask.mutate({ taskId, patch }),
      onAddChild: (parentId, name) => createChild.mutate({ parentId, name }),
      onDelete: (taskId, childPolicy) => deleteTask.mutate({ taskId, childPolicy }),
      onReparent: (taskId, newParentId) => reparentTask.mutate({ taskId, newParentId }),
    }),
    [canEdit, tasks, updateTask, createChild, deleteTask, reparentTask],
  );

  const columns = useMemo(() => {
    const base = [
      columnHelper.accessor('wbsCode', { header: 'WBS' }),
      columnHelper.display({
        id: 'name',
        header: 'Task name',
        cell: (info) => (
          <NameCell
            task={info.row.original}
            meta={meta}
            depth={wbsDepth(info.row.original.wbsCode)}
          />
        ),
      }),
      columnHelper.display({
        id: 'duration',
        header: 'Duration (h)',
        cell: (info) => <DurationCell task={info.row.original} meta={meta} />,
      }),
      columnHelper.display({
        id: 'start',
        header: 'Start',
        cell: (info) => <StartCell task={info.row.original} meta={meta} />,
      }),
      columnHelper.display({
        id: 'finish',
        header: 'Finish',
        cell: (info) => <FinishCell task={info.row.original} />,
      }),
      columnHelper.display({
        id: 'pctComplete',
        header: '% complete',
        cell: (info) => <PctCompleteCell task={info.row.original} meta={meta} />,
      }),
      columnHelper.display({
        id: 'milestone',
        header: 'Milestone',
        cell: (info) => <MilestoneCell task={info.row.original} meta={meta} />,
      }),
      columnHelper.display({
        id: 'priority',
        header: 'Priority',
        cell: (info) => <PriorityCell task={info.row.original} meta={meta} />,
      }),
      columnHelper.display({
        id: 'status',
        header: 'Status',
        cell: (info) => <StatusCell task={info.row.original} meta={meta} />,
      }),
      columnHelper.display({
        id: 'notes',
        header: 'Notes',
        cell: (info) => <NotesCell task={info.row.original} meta={meta} />,
      }),
    ];
    if (!canEdit) return base;
    return [
      ...base,
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        cell: (info) => <ActionsCell task={info.row.original} meta={meta} />,
      }),
    ];
  }, [canEdit, meta]);

  const table = useReactTable({
    data: tasks as Task[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  return (
    <div className="task-tree">
      {errorMessage !== null ? <p role="alert">{errorMessage}</p> : null}
      <table className="task-tree__table" aria-label="Project tasks (WBS)">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} scope="col">
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
