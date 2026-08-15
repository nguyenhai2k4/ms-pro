/**
 * FR-PRJ-07 / UC-1: a project with no tasks offers the next action rather than a blank screen.
 *
 * The two routes out of the empty state are exactly the two UC-1 describes — add the first task,
 * or import an existing plan (UC-8, FR-IMP-01). Import is not implemented until P7, so the button
 * says so plainly instead of failing when pressed; an affordance that looks live and is not is
 * worse than one that is honest.
 */
export interface EmptyProjectStateProps {
  readonly projectName: string;
  readonly canEdit: boolean;
  readonly onAddFirstTask: () => void;
  readonly onImport?: () => void;
}

export function EmptyProjectState({
  projectName,
  canEdit,
  onAddFirstTask,
  onImport,
}: EmptyProjectStateProps): JSX.Element {
  return (
    <section className="empty-state" aria-labelledby="empty-state-heading">
      <h2 id="empty-state-heading">{projectName} has no tasks yet</h2>
      <p>
        Start by adding the first task, or bring in a plan you already have. Dates and the critical
        path are calculated for you as soon as there is something to schedule.
      </p>

      {canEdit ? (
        <div className="empty-state__actions">
          <button type="button" onClick={onAddFirstTask}>
            Add the first task
          </button>
          <button type="button" onClick={onImport} disabled={onImport === undefined}>
            Import from CSV or XLSX
            {onImport === undefined ? ' (available later)' : ''}
          </button>
        </div>
      ) : (
        <p>You have read-only access to this project, so there is nothing to add here yet.</p>
      )}
    </section>
  );
}
