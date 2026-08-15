import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskTree } from './TaskTree.jsx';
import { createMockApi, makeTask, withQueryClient } from './test-support.jsx';

/**
 * FR-TSK-01..09, FR-VIEW-03, CLAUDE.md invariant 3. Built against the plain `Task` entity — no
 * `GanttTaskView`/CPM fields, matching the P1 scope decision documented in `TaskTree.tsx`.
 *
 * Every assertion on a mocked API call goes through `waitFor`: `TaskTree`'s mutations run through
 * TanStack Query's `useMutation`, which invokes `mutationFn` on a microtask, not synchronously
 * inside the click/blur handler — asserting immediately after `fireEvent` would race it.
 */

const summaryTask = makeTask({
  id: 'summary',
  parentId: null,
  wbsCode: '1',
  name: 'Phase one',
});
const leafA = makeTask({
  id: 'leafA',
  parentId: 'summary',
  wbsCode: '1.1',
  name: 'Excavate',
});
const leafB = makeTask({
  id: 'leafB',
  parentId: 'summary',
  wbsCode: '1.2',
  name: 'Pour foundations',
});
const milestone = makeTask({
  id: 'ms1',
  parentId: null,
  wbsCode: '2',
  name: 'Design sign-off',
  isMilestone: true,
  durationHours: 0,
});

const projectId = 'p1';
const tasks = [summaryTask, leafA, leafB, milestone];

const rowFor = (wbsLabel: string): HTMLElement => {
  const el = screen.getByLabelText(`Name for ${wbsLabel}`).closest('tr');
  if (el === null) throw new Error(`no <tr> for ${wbsLabel}`);
  return el;
};

describe('TaskTree (FR-TSK-01..09, FR-VIEW-03)', () => {
  it('renders every task, indented from parentId', () => {
    const api = createMockApi();
    render(withQueryClient(<TaskTree api={api} projectId={projectId} tasks={tasks} canEdit />));

    const table = screen.getByRole('table', { name: 'Project tasks (WBS)' });
    expect(table).toBeTruthy();

    const rootName = screen.getByLabelText('Name for 1') as HTMLInputElement;
    const childName = screen.getByLabelText('Name for 1.1') as HTMLInputElement;
    expect(rootName.value).toBe('Phase one');
    expect(childName.value).toBe('Excavate');

    expect(rootName.closest('div')?.style.paddingLeft).toBe('0rem');
    expect(childName.closest('div')?.style.paddingLeft).toBe('1.5rem');
  });

  it('disables start, duration and % complete on a task that has children, and says why', () => {
    const api = createMockApi();
    render(withQueryClient(<TaskTree api={api} projectId={projectId} tasks={tasks} canEdit />));

    const duration = screen.getByLabelText('Duration in hours for 1 Phase one');
    const start = screen.getByLabelText('Start date for 1 Phase one');
    const pctComplete = screen.getByLabelText('Percent complete for 1 Phase one');

    expect(duration.hasAttribute('disabled')).toBe(true);
    expect(start.hasAttribute('disabled')).toBe(true);
    expect(pctComplete.hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText(/Rolls up from children/).length).toBeGreaterThan(0);

    // The same fields on a leaf task are not disabled by the rollup rule.
    const leafDuration = screen.getByLabelText('Duration in hours for 1.1 Excavate');
    expect(leafDuration.hasAttribute('disabled')).toBe(false);
  });

  it('calls updateTask with the right project/task id and body when a leaf field is edited', async () => {
    const api = createMockApi();
    render(withQueryClient(<TaskTree api={api} projectId={projectId} tasks={tasks} canEdit />));

    const name = screen.getByLabelText('Name for 1.1') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Excavate site' } });
    fireEvent.blur(name);

    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith('p1', 'leafA', { name: 'Excavate site' }),
    );
  });

  it('sends duration 0 alongside isMilestone when a leaf is turned into a milestone', async () => {
    const api = createMockApi();
    render(withQueryClient(<TaskTree api={api} projectId={projectId} tasks={tasks} canEdit />));

    const checkbox = within(rowFor('1.1')).getByLabelText('Milestone');
    fireEvent.click(checkbox);

    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith('p1', 'leafA', {
        isMilestone: true,
        durationHours: 0,
      }),
    );
  });

  it('deleting a task with children prompts for a child policy before calling the API', async () => {
    const api = createMockApi();
    render(withQueryClient(<TaskTree api={api} projectId={projectId} tasks={tasks} canEdit />));

    const summaryRow = rowFor('1');
    fireEvent.click(within(summaryRow).getByRole('button', { name: 'Delete' }));

    // No call yet: the policy has not been chosen.
    expect(api.deleteTask).not.toHaveBeenCalled();
    expect(within(summaryRow).getByText(/sub-tasks/)).toBeTruthy();

    fireEvent.click(within(summaryRow).getByRole('button', { name: 'Delete them too' }));
    await waitFor(() =>
      expect(api.deleteTask).toHaveBeenCalledWith('p1', 'summary', { childPolicy: 'cascade' }),
    );
  });

  it('deleting a childless task does not prompt for a child policy', async () => {
    const api = createMockApi();
    render(withQueryClient(<TaskTree api={api} projectId={projectId} tasks={tasks} canEdit />));

    const leafRow = rowFor('1.1');
    fireEvent.click(within(leafRow).getByRole('button', { name: 'Delete' }));
    expect(within(leafRow).queryByText(/sub-tasks/)).toBeNull();

    fireEvent.click(within(leafRow).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteTask).toHaveBeenCalledWith('p1', 'leafA', undefined));
  });

  it('shows a clear message for a 409 conflict (childPolicy supplied for a childless task)', async () => {
    const conflictError = Object.assign(new Error('This task has no children'), {
      name: 'ApiRequestError',
    });
    const api = createMockApi({ deleteTask: vi.fn().mockRejectedValue(conflictError) });
    render(withQueryClient(<TaskTree api={api} projectId={projectId} tasks={tasks} canEdit />));

    const leafRow = rowFor('1.1');
    fireEvent.click(within(leafRow).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(leafRow).getByRole('button', { name: 'Delete' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This task has no children');
  });

  it('marks a milestone task with more than colour alone', () => {
    const api = createMockApi();
    render(withQueryClient(<TaskTree api={api} projectId={projectId} tasks={tasks} canEdit />));

    const milestoneRow = rowFor('2');
    const badge = milestoneRow.querySelector('.task-tree__milestone-badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('Milestone');
    // The icon is decorative (aria-hidden); the accompanying text is what makes it accessible —
    // scoped to the badge specifically, since the row's own edit checkbox is also labelled
    // "Milestone" and would otherwise make a bare text query ambiguous.
    const icon = badge?.querySelector('[aria-hidden="true"]');
    expect(icon?.textContent).toBe('◆');
  });

  it.each(['contributor', 'viewer'] as const)(
    'renders no edit/create/delete affordances for a %s',
    () => {
      const api = createMockApi();
      render(
        withQueryClient(<TaskTree api={api} projectId={projectId} tasks={tasks} canEdit={false} />),
      );

      expect(screen.queryAllByRole('button').length).toBe(0);
      const table = screen.getByRole('table', { name: 'Project tasks (WBS)' });
      expect(table.querySelectorAll('input, select, textarea, form').length).toBe(0);
      expect(screen.getByText('Phase one')).toBeTruthy();
    },
  );
});
