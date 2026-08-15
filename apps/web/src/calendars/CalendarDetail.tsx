import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { CalendarException } from '@projectapp/shared-types';
import type { CalendarApi } from './CalendarSettings.jsx';
import {
  WEEKDAY_OPTIONS,
  describeApiError,
  formatHoursRange,
  formatWorkingDays,
  minutesToTimeInputValue,
  timeInputValueToMinutes,
} from './calendarFormat.js';

/**
 * One calendar's editable detail (FR-CAL-01) plus its date exceptions (FR-CAL-02).
 *
 * Read-only rendering (`canManage === false`) shows the same data with no edit/create/remove
 * affordance in the DOM at all — the server 403s `calendar:manage` for non-Admins, so this never
 * offers a control that would only fail (CLAUDE.md invariant 3).
 */
export interface CalendarDetailProps {
  readonly api: CalendarApi;
  readonly projectId: string;
  readonly calendarId: string;
  readonly canManage: boolean;
  readonly onChanged: () => void;
}

export function CalendarDetail({
  api,
  projectId,
  calendarId,
  canManage,
  onChanged,
}: CalendarDetailProps): JSX.Element {
  const queryClient = useQueryClient();
  const detailQueryKey = ['calendar', projectId, calendarId];

  const detail = useQuery({
    queryKey: detailQueryKey,
    queryFn: () => api.getCalendar(projectId, calendarId),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: detailQueryKey });
    onChanged();
  };

  const calendar = detail.data?.calendar;

  // ---- edit form, seeded once per loaded calendar so a re-render mid-edit doesn't clobber
  // in-progress input, but a freshly-selected (or freshly-saved) calendar re-seeds. ----
  const [name, setName] = useState('');
  const [workingDays, setWorkingDays] = useState<number[]>([]);
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('17:00');
  const [editValidationError, setEditValidationError] = useState<string | null>(null);
  const [seededVersion, setSeededVersion] = useState<string | null>(null);

  useEffect(() => {
    if (calendar === undefined) return;
    const version = `${calendar.id}:${calendar.name}:${calendar.workingDays.join(',')}:${calendar.workingHoursStartMinute}:${calendar.workingHoursEndMinute}`;
    if (version === seededVersion) return;
    setName(calendar.name);
    setWorkingDays(calendar.workingDays);
    setStartTime(minutesToTimeInputValue(calendar.workingHoursStartMinute));
    setEndTime(minutesToTimeInputValue(calendar.workingHoursEndMinute));
    setSeededVersion(version);
  }, [calendar, seededVersion]);

  const update = useMutation({
    mutationFn: () =>
      api.updateCalendar(projectId, calendarId, {
        name,
        workingDays,
        workingHoursStartMinute: timeInputValueToMinutes(startTime),
        workingHoursEndMinute: timeInputValueToMinutes(endTime),
      }),
    onSuccess: invalidate,
  });

  function toggleEditDay(day: number): void {
    setWorkingDays((current) =>
      current.includes(day)
        ? current.filter((existing) => existing !== day)
        : [...current, day].sort((a, b) => a - b),
    );
  }

  function handleEditSubmit(): void {
    setEditValidationError(null);

    if (workingDays.length === 0) {
      setEditValidationError('Select at least one working day.');
      return;
    }

    const startMinute = timeInputValueToMinutes(startTime);
    const endMinute = timeInputValueToMinutes(endTime);
    if (endMinute <= startMinute) {
      setEditValidationError('Working hours end time must be after the start time.');
      return;
    }

    update.mutate();
  }

  // ---- add-exception form ----
  const [exceptionDate, setExceptionDate] = useState('');
  const [exceptionIsWorking, setExceptionIsWorking] = useState(false);
  const [exceptionStart, setExceptionStart] = useState('');
  const [exceptionEnd, setExceptionEnd] = useState('');
  const [exceptionValidationError, setExceptionValidationError] = useState<string | null>(null);

  const addException = useMutation({
    mutationFn: () =>
      api.addCalendarException(projectId, calendarId, {
        date: exceptionDate,
        isWorking: exceptionIsWorking,
        workingHoursStartMinuteOverride:
          exceptionStart === '' ? null : timeInputValueToMinutes(exceptionStart),
        workingHoursEndMinuteOverride:
          exceptionEnd === '' ? null : timeInputValueToMinutes(exceptionEnd),
      }),
    onSuccess: () => {
      setExceptionDate('');
      setExceptionIsWorking(false);
      setExceptionStart('');
      setExceptionEnd('');
      invalidate();
    },
  });

  const removeException = useMutation({
    mutationFn: (exceptionId: string) =>
      api.removeCalendarException(projectId, calendarId, exceptionId),
    onSuccess: invalidate,
  });

  function handleAddExceptionSubmit(): void {
    setExceptionValidationError(null);

    if (exceptionDate === '') {
      setExceptionValidationError('Choose a date.');
      return;
    }

    // Both overrides or neither — a single override hour is not a meaningful half-day.
    if (exceptionIsWorking && (exceptionStart !== '' || exceptionEnd !== '')) {
      if (exceptionStart === '' || exceptionEnd === '') {
        setExceptionValidationError(
          'Provide both an override start and end time for a half-day, or leave both blank.',
        );
        return;
      }
      // Fast client-side check; the server re-validates the same rule.
      if (timeInputValueToMinutes(exceptionEnd) <= timeInputValueToMinutes(exceptionStart)) {
        setExceptionValidationError('Override end time must be after the override start time.');
        return;
      }
    }

    addException.mutate();
  }

  if (detail.isLoading) return <p>Loading calendar…</p>;
  if (detail.isError || detail.data === undefined) {
    return <p role="alert">Could not load that calendar.</p>;
  }

  const exceptions = [...detail.data.exceptions].sort((a, b) => a.date.localeCompare(b.date));
  const headingId = `calendar-detail-heading-${calendarId}`;

  return (
    <section id={`calendar-detail-${calendarId}`} aria-labelledby={headingId}>
      <h3 id={headingId}>{detail.data.calendar.name}</h3>

      {canManage ? (
        <form
          aria-label={`Edit ${detail.data.calendar.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            handleEditSubmit();
          }}
        >
          <fieldset>
            <legend>Calendar details</legend>

            <label htmlFor={`edit-calendar-name-${calendarId}`}>Calendar name</label>
            <input
              id={`edit-calendar-name-${calendarId}`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />

            <fieldset>
              <legend>Working days</legend>
              {WEEKDAY_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  htmlFor={`edit-calendar-day-${calendarId}-${option.value}`}
                >
                  <input
                    type="checkbox"
                    id={`edit-calendar-day-${calendarId}-${option.value}`}
                    checked={workingDays.includes(option.value)}
                    onChange={() => toggleEditDay(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>

            <label htmlFor={`edit-calendar-start-${calendarId}`}>Working hours start</label>
            <input
              id={`edit-calendar-start-${calendarId}`}
              type="time"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              required
            />

            <label htmlFor={`edit-calendar-end-${calendarId}`}>Working hours end</label>
            <input
              id={`edit-calendar-end-${calendarId}`}
              type="time"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              required
            />

            <button type="submit" disabled={update.isPending}>
              Save calendar
            </button>
          </fieldset>

          {editValidationError !== null ? <p role="alert">{editValidationError}</p> : null}
          {update.isError ? (
            <p role="alert">{describeApiError(update.error, 'Could not save that calendar.')}</p>
          ) : null}
        </form>
      ) : (
        <dl>
          <dt>Working days</dt>
          <dd>{formatWorkingDays(detail.data.calendar.workingDays)}</dd>
          <dt>Working hours</dt>
          <dd>
            {formatHoursRange(
              detail.data.calendar.workingHoursStartMinute,
              detail.data.calendar.workingHoursEndMinute,
            )}
          </dd>
        </dl>
      )}

      <h4>Date exceptions</h4>
      {exceptions.length === 0 ? (
        <p>No date exceptions for this calendar.</p>
      ) : (
        <table aria-label={`Date exceptions for ${detail.data.calendar.name}`}>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Status</th>
              {canManage ? <th scope="col">Remove</th> : null}
            </tr>
          </thead>
          <tbody>
            {exceptions.map((exception) => (
              <tr key={exception.id}>
                <td>{exception.date}</td>
                <td>{describeException(exception)}</td>
                {canManage ? (
                  <td>
                    <button
                      type="button"
                      onClick={() => removeException.mutate(exception.id)}
                      disabled={removeException.isPending}
                    >
                      Remove exception for {exception.date}
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {removeException.isError ? (
        <p role="alert">
          {describeApiError(removeException.error, 'Could not remove that exception.')}
        </p>
      ) : null}

      {canManage ? (
        <form
          aria-label={`Add a date exception to ${detail.data.calendar.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            handleAddExceptionSubmit();
          }}
        >
          <fieldset>
            <legend>Add a date exception</legend>

            <label htmlFor={`exception-date-${calendarId}`}>Date</label>
            <input
              id={`exception-date-${calendarId}`}
              type="date"
              value={exceptionDate}
              onChange={(event) => setExceptionDate(event.target.value)}
              required
            />

            <label htmlFor={`exception-working-${calendarId}`}>
              <input
                type="checkbox"
                id={`exception-working-${calendarId}`}
                checked={exceptionIsWorking}
                onChange={(event) => setExceptionIsWorking(event.target.checked)}
              />
              Working (e.g. a half day) — leave unchecked for a non-working day such as a holiday
            </label>

            {exceptionIsWorking ? (
              <>
                <label htmlFor={`exception-start-${calendarId}`}>
                  Override start time (optional)
                </label>
                <input
                  id={`exception-start-${calendarId}`}
                  type="time"
                  value={exceptionStart}
                  onChange={(event) => setExceptionStart(event.target.value)}
                />

                <label htmlFor={`exception-end-${calendarId}`}>Override end time (optional)</label>
                <input
                  id={`exception-end-${calendarId}`}
                  type="time"
                  value={exceptionEnd}
                  onChange={(event) => setExceptionEnd(event.target.value)}
                />
              </>
            ) : null}

            <button type="submit" disabled={addException.isPending}>
              Add exception
            </button>
          </fieldset>

          {exceptionValidationError !== null ? (
            <p role="alert">{exceptionValidationError}</p>
          ) : null}
          {addException.isError ? (
            <p role="alert">
              {describeApiError(addException.error, 'Could not add that exception.')}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}

function describeException(exception: CalendarException): string {
  if (!exception.isWorking) return 'Non-working (holiday)';
  const { workingHoursStartMinuteOverride: start, workingHoursEndMinuteOverride: end } = exception;
  if (start !== null && end !== null) {
    return `Working, ${formatHoursRange(start, end)}`;
  }
  return 'Working (calendar default hours)';
}
