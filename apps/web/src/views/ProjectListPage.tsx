import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ApiClient } from '../api/client.js';

/**
 * FR-PRJ-02/03 and UC-1: the projects the caller is a member of, with the role they hold, plus
 * project creation. The role comes from the server (FR-AUTH-06) — the client never infers it.
 */
export interface ProjectListPageProps {
  readonly api: ApiClient;
  readonly onOpenProject: (projectId: string) => void;
  readonly onSignOut: () => void;
}

export function ProjectListPage({
  api,
  onOpenProject,
  onSignOut,
}: ProjectListPageProps): JSX.Element {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('2026-09-01');

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.listProjects() });

  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name,
        startDate: new Date(`${startDate}T08:00:00.000Z`).toISOString(),
        calendarTemplate: 'mon_fri',
      }),
    onSuccess: async (summary) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      setName('');
      onOpenProject(summary.project.id);
    },
  });

  return (
    <main>
      <header>
        <h1>Projects</h1>
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      {projects.isLoading ? <p>Loading…</p> : null}
      {projects.isError ? <p role="alert">Could not load your projects.</p> : null}

      {projects.data !== undefined ? (
        projects.data.items.length === 0 ? (
          // FR-PRJ-07's sibling: an account with no projects also gets an action, not a blank page.
          <p>You are not a member of any project yet. Create your first one below.</p>
        ) : (
          <ul>
            {projects.data.items.map((summary) => (
              <li key={summary.project.id}>
                <button type="button" onClick={() => onOpenProject(summary.project.id)}>
                  {summary.project.name}
                </button>
                <span> — your role: {summary.role}</span>
                <span> — {summary.taskCount} tasks</span>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <fieldset>
          <legend>New project</legend>

          <label htmlFor="project-name">Project name</label>
          <input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />

          <label htmlFor="project-start">Start date</label>
          <input
            id="project-start"
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
            required
          />

          <button type="submit" disabled={create.isPending}>
            Create project
          </button>
        </fieldset>
      </form>

      {create.isError ? <p role="alert">{(create.error as Error).message}</p> : null}
    </main>
  );
}
