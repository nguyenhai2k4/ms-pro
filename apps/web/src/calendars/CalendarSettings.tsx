import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiClient } from '../api/client.js';
import { CalendarCreateForm } from './CalendarCreateForm.jsx';
import { CalendarDetail } from './CalendarDetail.jsx';
import { formatHoursRange, formatWorkingDays } from './calendarFormat.js';

/**
 * The slice of `ApiClient` this surface needs. Narrower than the full client so tests (and any
 * future consumer) construct a fake without stubbing methods calendars never call — the real
 * `api` instance threaded through `App.tsx` already satisfies this structurally.
 */
export type CalendarApi = Pick<
  ApiClient,
  | 'listCalendars'
  | 'getCalendar'
  | 'createCalendar'
  | 'updateCalendar'
  | 'addCalendarException'
  | 'removeCalendarException'
>;

/**
 * FR-CAL-01..03: calendar management for a project — the list of calendars (default plus any
 * named extras), create, edit, and per-calendar date exceptions.
 *
 * `calendar:manage` is Admin-only server-side (RBAC); every role can read (`project:read`). Per
 * invariant 3 (CLAUDE.md) and the `EmptyProjectState` pattern, `canManage` gates whether the
 * create/edit/exception affordances render at all — a non-Admin sees the same data with no
 * button that would only 403 if pressed.
 */
export interface CalendarSettingsProps {
  readonly api: CalendarApi;
  readonly projectId: string;
  readonly canManage: boolean;
}

export function CalendarSettings({
  api,
  projectId,
  canManage,
}: CalendarSettingsProps): JSX.Element {
  const queryClient = useQueryClient();
  const [selectedCalendarId, setSelectedCalendarId] = useState<string | null>(null);

  const calendars = useQuery({
    queryKey: ['calendars', projectId],
    queryFn: () => api.listCalendars(projectId),
  });

  const invalidateList = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['calendars', projectId] });
  };

  if (calendars.isLoading) return <p>Loading calendars…</p>;
  if (calendars.isError || calendars.data === undefined) {
    return <p role="alert">Could not load calendars for this project.</p>;
  }

  const list = calendars.data.calendars;

  return (
    <section aria-labelledby="calendar-settings-heading">
      <h2 id="calendar-settings-heading">Calendars</h2>
      <p>
        Every role can view calendars; only Admins can create calendars, edit them, or manage date
        exceptions.
      </p>

      {list.length === 0 ? (
        <p>This project has no calendars yet.</p>
      ) : (
        <table aria-label="Calendars in this project">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Working days</th>
              <th scope="col">Working hours</th>
              <th scope="col">Default</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {list.map((calendar) => {
              const isSelected = selectedCalendarId === calendar.id;
              return (
                <tr key={calendar.id}>
                  <td>{calendar.name}</td>
                  <td>{formatWorkingDays(calendar.workingDays)}</td>
                  <td>
                    {formatHoursRange(
                      calendar.workingHoursStartMinute,
                      calendar.workingHoursEndMinute,
                    )}
                  </td>
                  <td>{calendar.isDefault ? 'Yes' : 'No'}</td>
                  <td>
                    <button
                      type="button"
                      aria-expanded={isSelected}
                      // Only while the panel is actually in the document: `aria-controls` naming
                      // an id that does not exist is an invalid reference, and a screen reader
                      // that follows it lands nowhere (WCAG 4.1.2).
                      aria-controls={isSelected ? `calendar-detail-${calendar.id}` : undefined}
                      onClick={() => setSelectedCalendarId(isSelected ? null : calendar.id)}
                    >
                      {isSelected
                        ? 'Hide details'
                        : canManage
                          ? `Manage ${calendar.name}`
                          : `View ${calendar.name}`}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {selectedCalendarId !== null ? (
        <CalendarDetail
          key={selectedCalendarId}
          api={api}
          projectId={projectId}
          calendarId={selectedCalendarId}
          canManage={canManage}
          onChanged={invalidateList}
        />
      ) : null}

      {canManage ? (
        <CalendarCreateForm api={api} projectId={projectId} onCreated={invalidateList} />
      ) : null}
    </section>
  );
}
