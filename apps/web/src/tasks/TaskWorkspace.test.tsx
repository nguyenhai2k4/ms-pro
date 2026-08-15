import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskWorkspace } from './TaskWorkspace.jsx';
import { createMockApi, makeTask, withQueryClient } from './test-support.jsx';

/**
 * FR-PRJ-07/UC-1, FR-TSK-01, FR-VIEW-03: the empty-state -> first-task -> WBS tree handoff.
 * `TaskWorkspace` decides empty vs. non-empty from `listTasks` itself, so this test asserts the
 * real create flow (mocked `ApiClient`, no server), not a hand-patched local list.
 */
describe('TaskWorkspace', () => {
  it('creates the first task via the real API and shows the tree afterward', async () => {
    const createdTask = makeTask({ id: 't1', wbsCode: '1', name: 'Excavate' });
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce({ tasks: [] })
      .mockResolvedValueOnce({ tasks: [createdTask] });
    const createTask = vi.fn().mockResolvedValue({ task: createdTask });
    const api = createMockApi({ listTasks, createTask });

    render(
      withQueryClient(
        <TaskWorkspace api={api} projectId="p1" projectName="Warehouse build" role="admin" />,
      ),
    );

    const addFirst = await screen.findByRole('button', { name: /Add the first task/ });
    fireEvent.click(addFirst);

    const nameInput = screen.getByLabelText('Task name');
    fireEvent.change(nameInput, { target: { value: 'Excavate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    // `createTask.mutate()` runs `mutationFn` on a microtask, not synchronously inside the click
    // handler — waiting for the tree to actually appear (which only happens once the mutation has
    // settled and the task list has been refetched) is a real await, not a race with it.
    const table = await screen.findByRole('table', { name: 'Project tasks (WBS)' });
    expect(table).toBeTruthy();
    expect(listTasks).toHaveBeenCalledTimes(2);

    expect(createTask).toHaveBeenCalledWith('p1', {
      parentId: null,
      name: 'Excavate',
      durationHours: 8,
      start: null,
      isMilestone: false,
      scheduleMode: 'auto',
      constraintType: 'ASAP',
      constraintDate: null,
      calendarId: null,
      priority: 500,
    });
  });

  it('offers no first-task affordance for a read-only role', async () => {
    const api = createMockApi({ listTasks: vi.fn().mockResolvedValue({ tasks: [] }) });

    render(
      withQueryClient(
        <TaskWorkspace api={api} projectId="p1" projectName="Warehouse build" role="viewer" />,
      ),
    );

    await screen.findByText(/has no tasks yet/);
    expect(screen.queryByRole('button', { name: /Add the first task/ })).toBeNull();
  });
});
