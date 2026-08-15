import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { createApiClient } from './api/client.js';
import { CalendarSettings } from './calendars/CalendarSettings.jsx';
import { useSessionStore } from './store/session.js';
import { EmptyProjectState } from './views/EmptyProjectState.jsx';
import { SignInPage } from './views/SignInPage.jsx';
import { ProjectListPage } from './views/ProjectListPage.jsx';

/**
 * P0 shell: sign in, list projects, create a project, land in its empty state.
 *
 * Deliberately not here — these are P1 and later, and stubbing them now would create UI that has
 * to be thrown away once the data model is exercised: task CRUD, the Gantt route, Kanban,
 * Calendar, resource sheet, reports.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export function App(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}

function Shell(): JSX.Element {
  const token = useSessionStore((state) => state.token);
  const signOut = useSessionStore((state) => state.signOut);
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: import.meta.env['VITE_API_BASE_URL'] ?? 'http://localhost:3001',
        getToken: () => useSessionStore.getState().token,
      }),
    [],
  );

  if (token === null) return <SignInPage api={api} />;
  if (openProjectId === null) {
    return <ProjectListPage api={api} onOpenProject={setOpenProjectId} onSignOut={signOut} />;
  }
  return <ProjectPage api={api} projectId={openProjectId} onBack={() => setOpenProjectId(null)} />;
}

interface ProjectPageProps {
  readonly api: ReturnType<typeof createApiClient>;
  readonly projectId: string;
  readonly onBack: () => void;
}

function ProjectPage({ api, projectId, onBack }: ProjectPageProps): JSX.Element {
  const [section, setSection] = useState<'tasks' | 'calendars'>('tasks');

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId),
  });

  const addTask = useMutation({
    // Task creation lands in P1 (FR-TSK-01). The empty state's primary action is wired to a
    // mutation that does not exist yet, so it reports that rather than pretending.
    mutationFn: async () => {
      throw new Error('Task creation ships in P1 (FR-TSK-01).');
    },
  });

  if (project.isLoading) return <p>Loading project…</p>;
  if (project.isError || project.data === undefined) return <p>Could not load that project.</p>;

  const summary = project.data;
  const canEdit = summary.role === 'admin' || summary.role === 'editor';
  // FR-CAL-01..03: unlike task edit (Admin or Editor), calendar mutation is Admin-only
  // server-side — `canEdit` above is deliberately not reused for this.
  const canManageCalendars = summary.role === 'admin';

  return (
    <main>
      <button type="button" onClick={onBack}>
        Back to projects
      </button>
      <h1>{summary.project.name}</h1>

      <nav aria-label="Project sections">
        <button
          type="button"
          aria-current={section === 'tasks' ? 'page' : undefined}
          onClick={() => setSection('tasks')}
        >
          Tasks
        </button>
        <button
          type="button"
          aria-current={section === 'calendars' ? 'page' : undefined}
          onClick={() => setSection('calendars')}
        >
          Calendars
        </button>
      </nav>

      {section === 'calendars' ? (
        <CalendarSettings api={api} projectId={projectId} canManage={canManageCalendars} />
      ) : summary.taskCount === 0 ? (
        <EmptyProjectState
          projectName={summary.project.name}
          canEdit={canEdit}
          onAddFirstTask={() => addTask.mutate()}
        />
      ) : (
        <p>{summary.taskCount} tasks. The Gantt and grid views arrive in P1.</p>
      )}

      {addTask.isError ? <p role="alert">{(addTask.error as Error).message}</p> : null}
    </main>
  );
}
