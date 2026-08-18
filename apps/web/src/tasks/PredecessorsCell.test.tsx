import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client.js';
import { TaskTree } from './TaskTree.jsx';
import { createMockApi, makeDependency, makeTask, withQueryClient } from './test-support.jsx';

/**
 * The predecessor column's editing surface (FR-SCH-01, FR-SCH-02, FR-SCH-03, FR-VIEW-03).
 * `dependency-syntax.test.ts` covers the grammar itself in isolation; this file covers the same
 * grammar wired through `TaskTree` into the mocked `ApiClient`, plus the two behaviours that only
 * exist at the component level: the 409 cycle rejection (task names, reverted field) and the
 * RBAC read-only mirror. `TaskTree.a11y.test.tsx` covers keyboard/labelling for this column
 * alongside the rest of the grid, per that file's own convention.
 */

// Real UUIDs (not the plain-string ids the rest of this directory's fixtures use) because
// `dependencyCycleDetailsSchema` — exercised for real by `PredecessorsCell` when it parses a 409
// response's `details` — brands its ids with `.uuid()`. A plain string would fail that parse and
// mask the very behaviour the cycle test exists to prove.
const TARGET_ID = '11111111-1111-4111-8111-111111111111';
const PRED12_ID = '22222222-2222-4222-8222-222222222222';
const PRED7_ID = '33333333-3333-4333-8333-333333333333';
const PRED3_ID = '44444444-4444-4444-8444-444444444444';
const PRED9_ID = '55555555-5555-4555-8555-555555555555';
const DEP_ID = '66666666-6666-4666-8666-666666666666';

const target = makeTask({ id: TARGET_ID, parentId: null, wbsCode: '1', name: 'Design' });
const pred12 = makeTask({ id: PRED12_ID, parentId: null, wbsCode: '12', name: 'Site survey' });
const pred7 = makeTask({ id: PRED7_ID, parentId: null, wbsCode: '7', name: 'Permits' });
const pred3 = makeTask({ id: PRED3_ID, parentId: null, wbsCode: '3', name: 'Excavation' });
const pred9 = makeTask({ id: PRED9_ID, parentId: null, wbsCode: '9', name: 'Utilities' });

const tasks = [target, pred12, pred7, pred3, pred9];

const rowFor = (wbsLabel: string): HTMLElement => {
  const el = screen.getByLabelText(`Name for ${wbsLabel}`).closest('tr');
  if (el === null) throw new Error(`no <tr> for ${wbsLabel}`);
  return el;
};

describe('PredecessorsCell — writing a link (acceptance check a)', () => {
  it.each([
    ['12FS+2d', { predecessorId: PRED12_ID, type: 'FS', lagHours: 16 }],
    ['7SS', { predecessorId: PRED7_ID, type: 'SS', lagHours: 0 }],
    ['3FF-1d', { predecessorId: PRED3_ID, type: 'FF', lagHours: -8 }],
    ['9SF', { predecessorId: PRED9_ID, type: 'SF', lagHours: 0 }],
  ] as const)('accepts "%s" and creates the exact dependency body', async (input, expected) => {
    const api = createMockApi({
      createDependency: vi.fn().mockResolvedValue({ dependency: makeDependency() }),
    });
    render(withQueryClient(<TaskTree api={api} projectId="p1" tasks={tasks} canEdit />));

    const row = rowFor('1');
    const addInput = await within(row).findByLabelText('Add predecessor');
    fireEvent.change(addInput, { target: { value: input } });
    fireEvent.click(within(row).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(api.createDependency).toHaveBeenCalledWith('p1', {
        predecessorId: expected.predecessorId,
        successorId: TARGET_ID,
        type: expected.type,
        lagHours: expected.lagHours,
      }),
    );
  });

  it('accepts a bare task reference as FS with no lag', async () => {
    const api = createMockApi({
      createDependency: vi.fn().mockResolvedValue({ dependency: makeDependency() }),
    });
    render(withQueryClient(<TaskTree api={api} projectId="p1" tasks={tasks} canEdit />));

    const row = rowFor('1');
    const addInput = await within(row).findByLabelText('Add predecessor');
    fireEvent.change(addInput, { target: { value: '12' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(api.createDependency).toHaveBeenCalledWith('p1', {
        predecessorId: PRED12_ID,
        successorId: TARGET_ID,
        type: 'FS',
        lagHours: 0,
      }),
    );
  });

  it('sends only type/lagHours to updateDependency when an existing predecessor is re-lagged', async () => {
    const existing = makeDependency({
      id: DEP_ID,
      projectId: 'p1',
      predecessorId: PRED12_ID,
      successorId: TARGET_ID,
      type: 'FS',
      lagHours: 16,
    });
    const api = createMockApi({
      listDependencies: vi.fn().mockResolvedValue({ dependencies: [existing] }),
      updateDependency: vi.fn().mockResolvedValue({ dependency: existing }),
    });
    render(withQueryClient(<TaskTree api={api} projectId="p1" tasks={tasks} canEdit />));

    const row = rowFor('1');
    const editInput = await within(row).findByLabelText('Predecessor 1 for 1 Design');
    expect((editInput as HTMLInputElement).value).toBe('12FS+2d');

    fireEvent.change(editInput, { target: { value: '12FS+5d' } });
    fireEvent.blur(editInput);

    await waitFor(() =>
      expect(api.updateDependency).toHaveBeenCalledWith('p1', DEP_ID, { type: 'FS', lagHours: 40 }),
    );
  });
});

describe('PredecessorsCell — malformed input (acceptance check b)', () => {
  it.each([
    ['999FS', /No task with WBS code/],
    ['12XY', /is not a dependency type/],
    ['12FS+abc', /is not a lag/],
  ] as const)('shows an inline error for "%s" and calls no API method', async (input, expected) => {
    const api = createMockApi({ createDependency: vi.fn() });
    render(withQueryClient(<TaskTree api={api} projectId="p1" tasks={tasks} canEdit />));

    const row = rowFor('1');
    const addInput = await within(row).findByLabelText('Add predecessor');
    fireEvent.change(addInput, { target: { value: input } });
    fireEvent.click(within(row).getByRole('button', { name: 'Add' }));

    expect(within(row).getByRole('alert').textContent).toMatch(expected);
    expect(api.createDependency).not.toHaveBeenCalled();
    expect(api.updateDependency).not.toHaveBeenCalled();
    expect(api.deleteDependency).not.toHaveBeenCalled();
  });
});

describe('PredecessorsCell — cycle rejection (acceptance check c)', () => {
  it('renders task names (not ids) from a 409 dependency_cycle and reverts the field', async () => {
    const existing = makeDependency({
      id: DEP_ID,
      projectId: 'p1',
      predecessorId: PRED12_ID,
      successorId: TARGET_ID,
      type: 'FS',
      lagHours: 16,
    });
    const cycleError = new ApiRequestError(409, {
      code: 'dependency_cycle',
      message: 'That link would close a cycle',
      requestId: 'req-1',
      details: {
        cyclePath: [PRED12_ID, TARGET_ID, PRED7_ID, PRED12_ID],
        cycleDependencyIds: [DEP_ID],
      },
    });
    const api = createMockApi({
      listDependencies: vi.fn().mockResolvedValue({ dependencies: [existing] }),
      updateDependency: vi.fn().mockRejectedValue(cycleError),
    });
    render(withQueryClient(<TaskTree api={api} projectId="p1" tasks={tasks} canEdit />));

    const row = rowFor('1');
    const editInput = (await within(row).findByLabelText(
      'Predecessor 1 for 1 Design',
    )) as HTMLInputElement;
    expect(editInput.value).toBe('12FS+2d');

    fireEvent.change(editInput, { target: { value: '12FS+5d' } });
    fireEvent.blur(editInput);

    const alert = await within(row).findByRole('alert');
    expect(alert.textContent).toContain('Site survey → Design → Permits → Site survey');
    expect(alert.textContent).not.toContain(PRED12_ID);
    expect(alert.textContent).not.toContain(TARGET_ID);

    // Reverted, not left half-applied.
    await waitFor(() => expect(editInput.value).toBe('12FS+2d'));
  });
});

describe('PredecessorsCell — delete (FR-SCH-04)', () => {
  it('removes a predecessor link', async () => {
    const existing = makeDependency({
      id: DEP_ID,
      projectId: 'p1',
      predecessorId: PRED12_ID,
      successorId: TARGET_ID,
      type: 'FS',
      lagHours: 16,
    });
    const api = createMockApi({
      listDependencies: vi.fn().mockResolvedValue({ dependencies: [existing] }),
      deleteDependency: vi.fn().mockResolvedValue(undefined),
    });
    render(withQueryClient(<TaskTree api={api} projectId="p1" tasks={tasks} canEdit />));

    const row = rowFor('1');
    const removeButton = await within(row).findByRole('button', {
      name: `Remove predecessor 12FS+2d from 1 Design`,
    });
    fireEvent.click(removeButton);

    await waitFor(() => expect(api.deleteDependency).toHaveBeenCalledWith('p1', DEP_ID));
  });
});

describe('PredecessorsCell — RBAC mirroring (acceptance check d)', () => {
  it.each(['contributor', 'viewer'] as const)(
    'renders zero editing affordances for a %s, but keeps the read-only summary',
    async () => {
      const existing = makeDependency({
        id: DEP_ID,
        projectId: 'p1',
        predecessorId: PRED12_ID,
        successorId: TARGET_ID,
        type: 'FS',
        lagHours: 16,
      });
      const api = createMockApi({
        listDependencies: vi.fn().mockResolvedValue({ dependencies: [existing] }),
      });
      render(withQueryClient(<TaskTree api={api} projectId="p1" tasks={tasks} canEdit={false} />));

      // A read-only `NameCell` is plain text, not a labelled control (`rowFor` relies on the
      // "Name for <wbs>" `aria-label` `NameCell` only renders when `canEdit`), so the row is found
      // by its (equally unique) task name instead.
      const summary = await screen.findByText('12FS+2d');
      const row = summary.closest('tr');
      if (row === null) throw new Error('no <tr> for the Design row');

      expect(within(row).queryAllByRole('textbox')).toEqual([]);
      expect(within(row).queryAllByRole('button')).toEqual([]);
      expect(within(row).queryAllByRole('form')).toEqual([]);
      expect(row.querySelectorAll('input, select, textarea, form, button')).toHaveLength(0);
    },
  );
});
