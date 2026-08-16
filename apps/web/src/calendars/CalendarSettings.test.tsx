import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  Calendar,
  CalendarException,
  CalendarExceptionResponse,
  CalendarListResponse,
  CalendarResponse,
  CreateCalendarExceptionRequest,
  CreateCalendarRequest,
  UpdateCalendarRequest,
} from '@projectapp/shared-types';
import { ApiRequestError } from '../api/client.js';
import type { CalendarApi } from './CalendarSettings.jsx';
import { CalendarSettings } from './CalendarSettings.jsx';

/**
 * FR-CAL-01..02, UC calendar management: list/create/edit calendars and their date exceptions,
 * with RBAC-aware rendering (invariant 3 — a role that would 403 server-side is never offered the
 * button in the first place).
 */

function defaultCalendar(overrides: Partial<Calendar> = {}): Calendar {
  return {
    id: 'cal-default' as Calendar['id'],
    projectId: 'proj-1' as Calendar['projectId'],
    name: 'Project default',
    workingDays: [1, 2, 3, 4, 5],
    workingHoursStartMinute: 480, // 08:00
    workingHoursEndMinute: 1020, // 17:00
    isDefault: true,
    ...overrides,
  };
}

function exception(overrides: Partial<CalendarException> = {}): CalendarException {
  return {
    id: 'exc-1' as CalendarException['id'],
    calendarId: 'cal-default' as CalendarException['calendarId'],
    date: '2026-12-25',
    isWorking: false,
    workingHoursStartMinuteOverride: null,
    workingHoursEndMinuteOverride: null,
    ...overrides,
  };
}

interface MockApiOptions {
  readonly calendars?: Calendar[];
  readonly exceptionsByCalendarId?: Record<string, CalendarException[]>;
  readonly addCalendarException?: (
    calendarId: string,
    body: CreateCalendarExceptionRequest,
  ) => Promise<CalendarExceptionResponse>;
  readonly removeCalendarException?: (calendarId: string, exceptionId: string) => Promise<void>;
}

function makeMockApi(options: MockApiOptions = {}) {
  // `listCalendars`/`getCalendar` close over these `let`s and re-read them on every call, but a
  // write always *reassigns a new array* rather than mutating one in place. That matters: if a
  // write instead did `calendars.push(...)`, the "before" and "after" snapshots TanStack Query
  // compares during a refetch would be the exact same (mutated) array reference, its structural-
  // sharing equality check would see "no change", and the UI would never re-render — a real trap
  // for a test double, not a production concern (a real server always returns a fresh array).
  let calendars = options.calendars ?? [defaultCalendar()];
  let exceptionsByCalendarId = options.exceptionsByCalendarId ?? {};

  const listCalendars = vi.fn(async (): Promise<CalendarListResponse> => ({ calendars }));

  const getCalendar = vi.fn(
    async (_projectId: string, calendarId: string): Promise<CalendarResponse> => {
      const calendar = calendars.find((entry) => entry.id === calendarId);
      if (calendar === undefined)
        throw new Error(`no such calendar in test fixture: ${calendarId}`);
      return { calendar, exceptions: exceptionsByCalendarId[calendarId] ?? [] };
    },
  );

  const createCalendar = vi.fn(
    async (_projectId: string, body: CreateCalendarRequest): Promise<CalendarResponse> => {
      const created: Calendar = {
        id: 'cal-new' as Calendar['id'],
        projectId: 'proj-1' as Calendar['projectId'],
        name: body.name,
        workingDays: body.workingDays,
        workingHoursStartMinute: body.workingHoursStartMinute,
        workingHoursEndMinute: body.workingHoursEndMinute,
        isDefault: false,
      };
      calendars = [...calendars, created];
      return { calendar: created, exceptions: [] };
    },
  );

  const updateCalendar = vi.fn(
    async (
      _projectId: string,
      calendarId: string,
      body: UpdateCalendarRequest,
    ): Promise<CalendarResponse> => ({
      calendar: { ...defaultCalendar({ id: calendarId as Calendar['id'] }), ...body },
      exceptions: [],
    }),
  );

  const addCalendarException = vi.fn(
    async (
      _projectId: string,
      calendarId: string,
      body: CreateCalendarExceptionRequest,
    ): Promise<CalendarExceptionResponse> => {
      if (options.addCalendarException !== undefined)
        return options.addCalendarException(calendarId, body);
      const created: CalendarException = {
        id: 'exc-new' as CalendarException['id'],
        calendarId: calendarId as CalendarException['calendarId'],
        date: body.date,
        isWorking: body.isWorking,
        workingHoursStartMinuteOverride: body.workingHoursStartMinuteOverride ?? null,
        workingHoursEndMinuteOverride: body.workingHoursEndMinuteOverride ?? null,
      };
      exceptionsByCalendarId = {
        ...exceptionsByCalendarId,
        [calendarId]: [...(exceptionsByCalendarId[calendarId] ?? []), created],
      };
      return { exception: created };
    },
  );

  const removeCalendarException = vi.fn(
    async (_projectId: string, calendarId: string, exceptionId: string): Promise<void> => {
      await options.removeCalendarException?.(calendarId, exceptionId);
      exceptionsByCalendarId = {
        ...exceptionsByCalendarId,
        [calendarId]: (exceptionsByCalendarId[calendarId] ?? []).filter(
          (entry) => entry.id !== exceptionId,
        ),
      };
    },
  );

  const api: CalendarApi = {
    listCalendars,
    getCalendar,
    createCalendar,
    updateCalendar,
    addCalendarException,
    removeCalendarException,
  };

  return {
    api,
    listCalendars,
    getCalendar,
    createCalendar,
    updateCalendar,
    addCalendarException,
    removeCalendarException,
  };
}

function renderCalendars(api: CalendarApi, canManage: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CalendarSettings api={api} projectId="proj-1" canManage={canManage} />
    </QueryClientProvider>,
  );
}

function setInputValue(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

describe('CalendarSettings (FR-CAL-01..02)', () => {
  it('renders the list of calendars including the default one', async () => {
    const { api } = makeMockApi({
      calendars: [
        defaultCalendar(),
        defaultCalendar({ id: 'cal-2' as Calendar['id'], name: 'Night shift', isDefault: false }),
      ],
    });
    renderCalendars(api, false);

    const table = await screen.findByRole('table', { name: 'Calendars in this project' });
    expect(within(table).getByText('Project default')).toBeTruthy();
    expect(within(table).getByText('Night shift')).toBeTruthy();
    // Human-readable weekday names, not raw ISO weekday numbers.
    expect(
      within(table).getAllByText('Monday, Tuesday, Wednesday, Thursday, Friday').length,
    ).toBeGreaterThan(0);
    expect(within(table).getAllByText('08:00–17:00').length).toBeGreaterThan(0);
  });

  it('Admin sees create/edit/add-exception/remove-exception affordances', async () => {
    const admin = makeMockApi({ exceptionsByCalendarId: { 'cal-default': [exception()] } });
    renderCalendars(admin.api, true);

    expect(await screen.findByRole('table', { name: 'Calendars in this project' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add calendar' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Manage Project default' }));
    expect(await screen.findByRole('button', { name: 'Save calendar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add exception' })).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: /Remove exception for 2026-12-25/ }),
    ).toBeTruthy();
  });

  it('a non-admin role sees the same data with none of those affordances in the DOM', async () => {
    const nonAdmin = makeMockApi({ exceptionsByCalendarId: { 'cal-default': [exception()] } });
    renderCalendars(nonAdmin.api, false);

    expect(await screen.findByRole('table', { name: 'Calendars in this project' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add calendar' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View Project default' }));
    await screen.findByText('2026-12-25');
    expect(screen.queryByRole('button', { name: 'Save calendar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add exception' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove exception/ })).toBeNull();
  });

  it('catches an invalid time range client-side before sending a create request', async () => {
    const { api, createCalendar } = makeMockApi();
    renderCalendars(api, true);
    await screen.findByRole('table', { name: 'Calendars in this project' });

    setInputValue(screen.getByLabelText('Calendar name'), 'Broken calendar');
    setInputValue(screen.getByLabelText('Working hours start'), '17:00');
    setInputValue(screen.getByLabelText('Working hours end'), '08:00');
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/end time must be after/i);
    expect(createCalendar).not.toHaveBeenCalled();
  });

  it('submits a valid create with the right project id and body, and the new calendar appears in the list', async () => {
    const { api, createCalendar } = makeMockApi();
    renderCalendars(api, true);
    await screen.findByRole('table', { name: 'Calendars in this project' });

    setInputValue(screen.getByLabelText('Calendar name'), 'Night shift');
    setInputValue(screen.getByLabelText('Working hours start'), '20:00');
    setInputValue(screen.getByLabelText('Working hours end'), '23:00');
    fireEvent.click(screen.getByRole('button', { name: 'Add calendar' }));

    await waitFor(() => expect(createCalendar).toHaveBeenCalledTimes(1));
    expect(createCalendar).toHaveBeenCalledWith('proj-1', {
      name: 'Night shift',
      workingDays: [1, 2, 3, 4, 5],
      workingHoursStartMinute: 20 * 60,
      workingHoursEndMinute: 23 * 60,
    });

    expect(await screen.findByText('Night shift')).toBeTruthy();
  });

  it('surfaces a duplicate exception date (409) as a specific, readable message', async () => {
    const { api } = makeMockApi({
      addCalendarException: async () => {
        throw new ApiRequestError(409, {
          code: 'conflict',
          message:
            'duplicate key value violates unique constraint "calendar_exception_calendar_id_date_key"',
          requestId: 'req-1',
        });
      },
    });
    renderCalendars(api, true);
    await screen.findByRole('table', { name: 'Calendars in this project' });

    fireEvent.click(screen.getByRole('button', { name: 'Manage Project default' }));
    await screen.findByRole('button', { name: 'Add exception' });

    setInputValue(screen.getByLabelText('Date'), '2026-12-25');
    fireEvent.click(screen.getByRole('button', { name: 'Add exception' }));

    const alert = await screen.findByText('An exception already exists for that date.');
    expect(alert).toBeTruthy();
    expect(screen.queryByText(/duplicate key value/)).toBeNull();
  });

  it('removing an exception calls removeCalendarException with the right ids', async () => {
    const { api, removeCalendarException } = makeMockApi({
      exceptionsByCalendarId: {
        'cal-default': [exception({ id: 'exc-7' as CalendarException['id'] })],
      },
    });
    renderCalendars(api, true);
    await screen.findByRole('table', { name: 'Calendars in this project' });

    fireEvent.click(screen.getByRole('button', { name: 'Manage Project default' }));
    const removeButton = await screen.findByRole('button', {
      name: /Remove exception for 2026-12-25/,
    });
    fireEvent.click(removeButton);

    await waitFor(() =>
      expect(removeCalendarException).toHaveBeenCalledWith('proj-1', 'cal-default', 'exc-7'),
    );
  });
});

// ------------------------------------------------------------------------------------------
// P1 review additions: RBAC mirroring queried from the DOM, and the WCAG basics.
// ------------------------------------------------------------------------------------------

const CONTROL_SELECTOR = 'input, select, textarea, button';

/** `CSS.escape` is not implemented in this jsdom version; ids here are simple enough for this. */
function escapeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

/**
 * The accessible name for a control, by the part of the accname algorithm this UI relies on:
 * `aria-label`, then a `<label for>`, then a wrapping `<label>`, then the element's own text
 * (which is what names a `<button>`).
 */
function accessibleName(element: Element): string {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim() !== '') return ariaLabel.trim();

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

describe('FR-ACL-03 / invariant 3: only an Admin gets a calendar edit affordance', () => {
  // `App.tsx` maps `role === 'admin'` to `canManage`; every other role lands here as `false`.
  // The three of them share one render path, so the loop is over what the roles *mean* rather
  // than over a prop that differs between them.
  for (const role of ['editor', 'contributor', 'viewer'] as const) {
    it(`renders no create/edit/exception control anywhere in the DOM for a ${role}`, async () => {
      const { api, createCalendar, updateCalendar, addCalendarException, removeCalendarException } =
        makeMockApi({ exceptionsByCalendarId: { 'cal-default': [exception()] } });
      const { container } = renderCalendars(api, false);

      await screen.findByRole('table', { name: 'Calendars in this project' });
      fireEvent.click(screen.getByRole('button', { name: 'View Project default' }));
      await screen.findByText('2026-12-25');

      // Swept from the DOM rather than asserted button by button: the only interactive control a
      // non-Admin may have is the disclosure toggle that reveals read-only detail.
      const controls = [...container.querySelectorAll(CONTROL_SELECTOR)];
      const names = controls.map(accessibleName).sort();
      expect(names).toEqual(['Hide details']);
      expect(container.querySelectorAll('form')).toHaveLength(0);

      // And nothing could have been called, since nothing was clickable.
      for (const mutator of [
        createCalendar,
        updateCalendar,
        addCalendarException,
        removeCalendarException,
      ]) {
        expect(mutator).not.toHaveBeenCalled();
      }

      // The data itself is fully visible — read-only, not hidden. It appears twice on purpose:
      // once in the list row and once in the read-only detail panel below it.
      expect(screen.getAllByText('Monday, Tuesday, Wednesday, Thursday, Friday')).toHaveLength(2);
      expect(screen.getByText('Non-working (holiday)')).toBeTruthy();
    });
  }

  it('does render the full edit surface for an admin, so the negatives above mean something', async () => {
    const { api } = makeMockApi({ exceptionsByCalendarId: { 'cal-default': [exception()] } });
    const { container } = renderCalendars(api, true);

    await screen.findByRole('table', { name: 'Calendars in this project' });
    fireEvent.click(screen.getByRole('button', { name: 'Manage Project default' }));
    await screen.findByRole('button', { name: 'Save calendar' });

    expect(container.querySelectorAll(CONTROL_SELECTOR).length).toBeGreaterThan(5);
    expect(container.querySelectorAll('form').length).toBeGreaterThan(0);
  });
});

describe('Calendar accessibility (invariant 6, WCAG 2.1 AA)', () => {
  it('gives every control in the admin surface a non-empty accessible name', async () => {
    const { api } = makeMockApi({ exceptionsByCalendarId: { 'cal-default': [exception()] } });
    const { container } = renderCalendars(api, true);

    await screen.findByRole('table', { name: 'Calendars in this project' });
    fireEvent.click(screen.getByRole('button', { name: 'Manage Project default' }));
    await screen.findByRole('button', { name: 'Save calendar' });
    // Reveal the conditional half-day fields too, which only render once "working" is checked.
    fireEvent.click(screen.getByLabelText(/Working \(e\.g\. a half day\)/));
    await screen.findByLabelText('Override start time (optional)');

    const controls = [...container.querySelectorAll(CONTROL_SELECTOR)];
    expect(controls.length).toBeGreaterThan(0);
    const unnamed = controls.filter((control) => accessibleName(control) === '');
    expect(unnamed.map((control) => control.outerHTML)).toEqual([]);
  });

  it('uses real column headers on both tables', async () => {
    const { api } = makeMockApi({ exceptionsByCalendarId: { 'cal-default': [exception()] } });
    renderCalendars(api, true);

    fireEvent.click(await screen.findByRole('button', { name: 'Manage Project default' }));
    const exceptionsTable = await screen.findByRole('table', {
      name: 'Date exceptions for Project default',
    });

    for (const table of [
      screen.getByRole('table', { name: 'Calendars in this project' }),
      exceptionsTable,
    ]) {
      const headers = [...table.querySelectorAll('thead th')];
      expect(headers.length).toBeGreaterThan(0);
      for (const header of headers) {
        expect(header.getAttribute('scope')).toBe('col');
        expect((header.textContent ?? '').trim()).not.toBe('');
      }
    }
  });

  it('only points aria-controls at a panel that is actually in the document', async () => {
    const { api } = makeMockApi();
    const { container } = renderCalendars(api, true);
    await screen.findByRole('table', { name: 'Calendars in this project' });

    // Collapsed: `aria-expanded="false"` and no dangling reference.
    const toggle = screen.getByRole('button', { name: 'Manage Project default' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeNull();

    fireEvent.click(toggle);
    // Wait for the panel itself, not just the relabelled button: the detail query is still in
    // flight at the moment of the click, and an `aria-controls` target that only materialises
    // later is exactly the dangling reference this test is about.
    await screen.findByRole('heading', { name: 'Project default' });
    const expanded = screen.getByRole('button', { name: 'Hide details' });
    const controls = expanded.getAttribute('aria-controls');
    expect(controls).not.toBeNull();
    expect(container.querySelector(`#${escapeId(controls!)}`)).not.toBeNull();
  });

  it('describes an exception in words, not by a status colour', async () => {
    const { api } = makeMockApi({
      exceptionsByCalendarId: {
        'cal-default': [
          exception({ id: 'holiday' as CalendarException['id'], date: '2026-12-25' }),
          exception({
            id: 'half' as CalendarException['id'],
            date: '2026-12-24',
            isWorking: true,
            workingHoursStartMinuteOverride: 540,
            workingHoursEndMinuteOverride: 720,
          }),
        ],
      },
    });
    renderCalendars(api, false);

    fireEvent.click(await screen.findByRole('button', { name: 'View Project default' }));
    const table = await screen.findByRole('table', {
      name: 'Date exceptions for Project default',
    });
    // A holiday and a half-day are distinguishable from the text alone.
    expect(within(table).getByText('Non-working (holiday)')).toBeTruthy();
    expect(within(table).getByText('Working, 09:00–12:00')).toBeTruthy();
  });
});
