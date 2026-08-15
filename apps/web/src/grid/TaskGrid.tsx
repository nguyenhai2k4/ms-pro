import type { GanttTaskView } from '@projectapp/shared-types/gantt';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import type { SortingState } from '@tanstack/react-table';
import { useMemo, useState } from 'react';

/**
 * The task grid shell (FR-VIEW-03), built on TanStack Table per the locked stack.
 *
 * P0 ships the column model, sorting and the accessible table semantics. Inline cell editing,
 * column show/hide/reorder and Gantt scroll synchronisation arrive with the task CRUD surface in
 * P1 — there is nothing to edit until tasks exist, and building an editor against a data model
 * that has not been exercised produces an editor that gets rewritten.
 *
 * Row virtualization is required before this is pointed at real projects (FR-VIEW-02: DOM grids
 * fall over past ~1,000 rows). It is not here yet and this is stated rather than assumed.
 */
export interface TaskGridProps {
  readonly tasks: readonly GanttTaskView[];
  readonly onSelectTask?: (taskId: string) => void;
}

const columnHelper = createColumnHelper<GanttTaskView>();

export function TaskGrid({ tasks, onSelectTask }: TaskGridProps): JSX.Element {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo(
    () => [
      columnHelper.accessor('wbsCode', { header: 'WBS' }),
      columnHelper.accessor('name', { header: 'Task name' }),
      columnHelper.accessor('start', {
        header: 'Start',
        cell: (info) => new Date(info.getValue()).toLocaleDateString('en-GB'),
      }),
      columnHelper.accessor('finish', {
        header: 'Finish',
        cell: (info) => new Date(info.getValue()).toLocaleDateString('en-GB'),
      }),
      columnHelper.accessor('pctComplete', {
        header: '% complete',
        cell: (info) => `${Math.round(info.getValue())}%`,
      }),
      // FR-SCH-10: the critical path is filterable in the grid, and is text here rather than
      // colour alone so the column is meaningful to a screen reader.
      columnHelper.accessor('isCritical', {
        header: 'Critical',
        cell: (info) => (info.getValue() ? 'Yes' : 'No'),
      }),
    ],
    [],
  );

  const table = useReactTable({
    data: tasks as GanttTaskView[],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <table className="task-grid" aria-label="Task grid">
      <thead>
        {table.getHeaderGroups().map((headerGroup) => (
          <tr key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <th
                key={header.id}
                scope="col"
                aria-sort={
                  header.column.getIsSorted() === 'asc'
                    ? 'ascending'
                    : header.column.getIsSorted() === 'desc'
                      ? 'descending'
                      : 'none'
                }
              >
                <button type="button" onClick={header.column.getToggleSortingHandler()}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </button>
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr
            key={row.id}
            data-critical={row.original.isCritical ? 'true' : 'false'}
            onClick={() => onSelectTask?.(row.original.id)}
          >
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
