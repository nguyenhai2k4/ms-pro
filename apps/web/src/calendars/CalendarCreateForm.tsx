import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { CalendarApi } from './CalendarSettings.jsx';
import { WEEKDAY_OPTIONS, describeApiError, timeInputValueToMinutes } from './calendarFormat.js';

/** FR-CAL-03: an additional named calendar in the project (e.g. a resource's PTO calendar). */
export interface CalendarCreateFormProps {
  readonly api: Pick<CalendarApi, 'createCalendar'>;
  readonly projectId: string;
  readonly onCreated: () => void;
}

const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_START_TIME = '08:00';
const DEFAULT_END_TIME = '17:00';

export function CalendarCreateForm({
  api,
  projectId,
  onCreated,
}: CalendarCreateFormProps): JSX.Element {
  const [name, setName] = useState('');
  const [workingDays, setWorkingDays] = useState<number[]>(DEFAULT_WORKING_DAYS);
  const [startTime, setStartTime] = useState(DEFAULT_START_TIME);
  const [endTime, setEndTime] = useState(DEFAULT_END_TIME);
  const [validationError, setValidationError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.createCalendar(projectId, {
        name,
        workingDays,
        workingHoursStartMinute: timeInputValueToMinutes(startTime),
        workingHoursEndMinute: timeInputValueToMinutes(endTime),
      }),
    onSuccess: () => {
      setName('');
      setWorkingDays(DEFAULT_WORKING_DAYS);
      setStartTime(DEFAULT_START_TIME);
      setEndTime(DEFAULT_END_TIME);
      onCreated();
    },
  });

  function toggleDay(day: number): void {
    setWorkingDays((current) =>
      current.includes(day)
        ? current.filter((existing) => existing !== day)
        : [...current, day].sort((a, b) => a - b),
    );
  }

  function handleSubmit(): void {
    setValidationError(null);

    if (workingDays.length === 0) {
      setValidationError('Select at least one working day.');
      return;
    }

    // Fast client-side check before a request goes out at all; the server re-validates this
    // (FR-CAL-03), so this is only for a quicker error, never a substitute for that check.
    const startMinute = timeInputValueToMinutes(startTime);
    const endMinute = timeInputValueToMinutes(endTime);
    if (endMinute <= startMinute) {
      setValidationError('Working hours end time must be after the start time.');
      return;
    }

    create.mutate();
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <fieldset>
        <legend>Add a calendar</legend>

        <label htmlFor="new-calendar-name">Calendar name</label>
        <input
          id="new-calendar-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />

        <fieldset>
          <legend>Working days</legend>
          {WEEKDAY_OPTIONS.map((option) => (
            <label key={option.value} htmlFor={`new-calendar-day-${option.value}`}>
              <input
                type="checkbox"
                id={`new-calendar-day-${option.value}`}
                checked={workingDays.includes(option.value)}
                onChange={() => toggleDay(option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>

        <label htmlFor="new-calendar-start">Working hours start</label>
        <input
          id="new-calendar-start"
          type="time"
          value={startTime}
          onChange={(event) => setStartTime(event.target.value)}
          required
        />

        <label htmlFor="new-calendar-end">Working hours end</label>
        <input
          id="new-calendar-end"
          type="time"
          value={endTime}
          onChange={(event) => setEndTime(event.target.value)}
          required
        />

        <button type="submit" disabled={create.isPending}>
          Add calendar
        </button>
      </fieldset>

      {validationError !== null ? <p role="alert">{validationError}</p> : null}
      {create.isError ? (
        <p role="alert">{describeApiError(create.error, 'Could not create that calendar.')}</p>
      ) : null}
    </form>
  );
}
