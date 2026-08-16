import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskTree } from './TaskTree.jsx';
import { TaskWorkspace } from './TaskWorkspace.jsx';
import { createMockApi, makeTask, withQueryClient } from './test-support.jsx';

/**
 * Invariant 3 (RBAC mirroring) and invariant 6 (accessibility is built in) for the P1 WBS grid.
 *
 * Two things this file checks that `TaskTree.test.tsx` does not:
 *
 *  1. **The role -> `canEdit` mapping**, not just the `canEdit` prop. `TaskTree.test.tsx` renders
 *     `canEdit={false}` directly, which proves the component honours the flag but says nothing
 *     about whether a Contributor ever gets `false`. `TaskWorkspace` is where the mapping lives
 *     (`role === 'admin' || role === 'editor'`), and a Contributor holding `task:update:assigned`
 *     on paper is exactly the role a future reader would be tempted to let through. Both the
 *     empty state and the populated tree are covered, because they are different render paths.
 *  2. **Accessible names, computed rather than assumed.** Asserting that a specific `aria-label`
 *     exists proves that one control is labelled; walking every control in the rendered table and
 *     requiring each to resolve to a non-empty name is what catches the next cell someone adds
 *     without one (WCAG 2.1 AA, 1.3.1 and 4.1.2).
 */

const summaryTask = makeTask({ id: 'summary', parentId: null, wbsCode: '1', name: 'Phase one' });
const leaf = makeTask({ id: 'leafA', parentId: 'summary', wbsCode: '1.1', name: 'Excavate' });
const milestone = makeTask({
  id: 'ms1',
  parentId: null,
  wbsCode: '2',
  name: 'Design sign-off',
  isMilestone: true,
  durationHours: 0,
});
const tasks = [summaryTask, leaf, milestone];

const CONTROL_SELECTOR = 'input, select, textarea, button';

/** `CSS.escape` is not implemented in this jsdom version; ids here are simple enough for this. */
function escapeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

/**
 * The accessible name for a form control, by the subset of the accname algorithm this UI actually
 * relies on: `aria-label`, then `aria-labelledby`, then a `<label for>`, then a wrapping `<label>`.
 * Deliberately not `element.labels` alone — that misses the `aria-label` case, which is how most
 * of the grid's cells are labelled.
 */
function accessibleName(element: Element): string {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();

  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text !== '') return text;
  }

  const id = element.getAttribute('id');
  if (id !== null && id !== '') {
    const explicit = element.ownerDocument.querySelector(`label[for="${escapeId(id)}"]`);
    if (explicit !== null && (explicit.textContent ?? '').trim() !== '') {
      return (explicit.textContent ?? '').trim();
    }
  }

  const wrapping = element.closest('label');
  if (wrapping !== null && (wrapping.textContent ?? '').trim() !== '') {
    return (wrapping.textContent ?? '').trim();
  }

  return (element.textContent ?? '').trim();
}

describe('TaskTree accessibility (invariant 6, WCAG 2.1 AA)', () => {
  it('gives every control in the grid a non-empty accessible name', () => {
    render(
      withQueryClient(<TaskTree api={createMockApi()} projectId="p1" tasks={tasks} canEdit />),
    );

    const table = screen.getByRole('table', { name: 'Project tasks (WBS)' });
    const controls = [...table.querySelectorAll(CONTROL_SELECTOR)];
    expect(controls.length).toBeGreaterThan(0);

    const unnamed = controls.filter((control) => accessibleName(control) === '');
    expect(
      unnamed.map((control) => `${control.tagName}[type=${control.getAttribute('type')}]`),
      'every control needs an accessible name',
    ).toEqual([]);
  });

  it('gives every control in an expanded action panel a non-empty accessible name', () => {
    render(
      withQueryClient(<TaskTree api={createMockApi()} projectId="p1" tasks={tasks} canEdit />),
    );

    const row = screen.getByLabelText('Name for 1.1').closest('tr')!;
    for (const trigger of ['Add child', 'Move to…', 'Delete']) {
      // Each panel replaces the cell's contents, so open them one at a time from a fresh render
      // of the row's default state.
      const button = within(row).queryByRole('button', { name: trigger });
      if (button === null) continue;
      button.click();

      const controls = [...row.querySelectorAll(CONTROL_SELECTOR)];
      const unnamed = controls.filter((control) => accessibleName(control) === '');
      expect(
        unnamed.map((c) => c.outerHTML),
        `${trigger} panel`,
      ).toEqual([]);

      const cancel = within(row).queryByRole('button', { name: 'Cancel' });
      cancel?.click();
    }
  });

  it('uses real column headers, so a screen reader can announce each cell by column', () => {
    render(
      withQueryClient(<TaskTree api={createMockApi()} projectId="p1" tasks={tasks} canEdit />),
    );

    const table = screen.getByRole('table', { name: 'Project tasks (WBS)' });
    const headers = [...table.querySelectorAll('thead th')];
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      expect(header.getAttribute('scope'), header.textContent ?? '').toBe('col');
      expect((header.textContent ?? '').trim()).not.toBe('');
    }
  });

  it('conveys milestone status in text, not by colour or an icon alone (WCAG 1.4.1)', () => {
    render(
      withQueryClient(<TaskTree api={createMockApi()} projectId="p1" tasks={tasks} canEdit />),
    );

    const milestoneRow = screen.getByLabelText('Name for 2').closest('tr')!;
    const badge = milestoneRow.querySelector('.task-tree__milestone-badge')!;
    // Strip the decorative glyph and require what is left to still say what the marker means.
    const decorative = badge.querySelector('[aria-hidden="true"]');
    expect(decorative).not.toBeNull();
    const spoken = (badge.textContent ?? '').replace(decorative?.textContent ?? '', '').trim();
    expect(spoken).toBe('Milestone');

    // A non-milestone row carries no such badge, so the cue is a real distinction.
    const leafRow = screen.getByLabelText('Name for 1.1').closest('tr')!;
    expect(leafRow.querySelector('.task-tree__milestone-badge')).toBeNull();
  });

  it('associates every rollup-disabled control with the note explaining why', () => {
    render(
      withQueryClient(<TaskTree api={createMockApi()} projectId="p1" tasks={tasks} canEdit />),
    );

    // A `disabled` attribute alone is silent — the reason has to reach assistive tech too, which
    // is what `aria-describedby` pointing at a real element in the document does.
    for (const label of [
      'Duration in hours for 1 Phase one',
      'Start date for 1 Phase one',
      'Percent complete for 1 Phase one',
    ]) {
      const control = screen.getByLabelText(label);
      expect(control.hasAttribute('disabled'), label).toBe(true);
      const describedBy = control.getAttribute('aria-describedby');
      expect(describedBy, `${label} needs aria-describedby`).not.toBeNull();
      const note = document.getElementById(describedBy!);
      expect(note, `${label} describedby target must exist`).not.toBeNull();
      expect((note!.textContent ?? '').trim()).not.toBe('');
    }
  });
});

describe('TaskWorkspace maps a role to edit rights (invariant 3, FR-ACL-04/05)', () => {
  const READ_ONLY_ROLES = ['contributor', 'viewer'] as const;
  const EDIT_ROLES = ['admin', 'editor'] as const;

  for (const role of READ_ONLY_ROLES) {
    it(`renders zero edit affordances in the populated tree for a ${role}`, async () => {
      const api = createMockApi({
        listTasks: async () => ({ tasks }),
      });
      render(
        withQueryClient(
          <TaskWorkspace api={api} projectId="p1" projectName="Warehouse build" role={role} />,
        ),
      );

      const table = await screen.findByRole('table', { name: 'Project tasks (WBS)' });
      // Queried from the DOM, not inferred from a prop: no control of any kind, anywhere.
      expect(screen.queryAllByRole('button')).toEqual([]);
      expect(screen.queryAllByRole('textbox')).toEqual([]);
      expect(screen.queryAllByRole('combobox')).toEqual([]);
      expect(screen.queryAllByRole('checkbox')).toEqual([]);
      expect(screen.queryAllByRole('spinbutton')).toEqual([]);
      expect([...table.querySelectorAll(CONTROL_SELECTOR)]).toEqual([]);
      expect(document.querySelectorAll('form')).toHaveLength(0);

      // The data is still all there — read-only, not hidden.
      expect(within(table).getByText('Phase one')).toBeTruthy();
      expect(within(table).getByText('Excavate')).toBeTruthy();
      expect(within(table).getByText('Design sign-off')).toBeTruthy();
      // Including the read-only rendering of every editable column.
      expect(within(table).getAllByText('8h').length).toBeGreaterThan(0);
      expect(within(table).getAllByText('Not started').length).toBeGreaterThan(0);
    });

    it(`renders no first-task affordance in the empty state for a ${role}`, async () => {
      const api = createMockApi({ listTasks: async () => ({ tasks: [] }) });
      render(
        withQueryClient(
          <TaskWorkspace api={api} projectId="p1" projectName="Warehouse build" role={role} />,
        ),
      );

      await screen.findByText(/has no tasks yet/);
      expect(screen.queryByRole('button', { name: /Add the first task/ })).toBeNull();
      expect(screen.queryAllByRole('button')).toEqual([]);
      expect(document.querySelectorAll('form')).toHaveLength(0);
    });
  }

  for (const role of EDIT_ROLES) {
    it(`does render the edit surface for an ${role}`, async () => {
      const api = createMockApi({ listTasks: async () => ({ tasks }) });
      render(
        withQueryClient(
          <TaskWorkspace api={api} projectId="p1" projectName="Warehouse build" role={role} />,
        ),
      );

      await screen.findByRole('table', { name: 'Project tasks (WBS)' });
      // The negative cases above are only meaningful if the positive one differs.
      expect(screen.queryAllByRole('button').length).toBeGreaterThan(0);
      expect(screen.getByLabelText('Name for 1.1')).toBeTruthy();
    });
  }
});
