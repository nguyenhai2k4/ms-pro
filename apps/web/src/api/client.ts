import type {
  ApiError,
  CalendarExceptionResponse,
  CalendarListResponse,
  CalendarResponse,
  CreateCalendarExceptionRequest,
  CreateCalendarRequest,
  CreateDependencyRequest,
  CreateProjectRequest,
  CreateTaskRequest,
  CurrentUserResponse,
  DeleteTaskRequest,
  DependencyListResponse,
  DependencyResponse,
  LoginRequest,
  ProjectSummary,
  RegisterRequest,
  ReparentTaskRequest,
  Session,
  TaskListResponse,
  TaskResponse,
  UpdateCalendarRequest,
  UpdateDependencyRequest,
  UpdateTaskRequest,
} from '@projectapp/shared-types';

/**
 * Typed transport to `apps/api`. Requests and responses are the contract types from
 * `@projectapp/shared-types` — the client never declares its own shape for a server payload,
 * because a hand-written duplicate is a copy that silently goes stale.
 */

export class ApiRequestError extends Error {
  readonly status: number;
  readonly error: ApiError;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.error = error;
  }
}

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly getToken: () => string | null;
  readonly fetchImpl?: typeof fetch;
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = options.getToken();
    const response = await doFetch(`${options.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 204) return undefined as T;

    const payload: unknown = await response.json();
    if (!response.ok) {
      throw new ApiRequestError(response.status, payload as ApiError);
    }
    return payload as T;
  }

  return {
    register: (body: RegisterRequest) => request<Session>('POST', '/auth/register', body),
    login: (body: LoginRequest) => request<Session>('POST', '/auth/login', body),
    logout: () => request<void>('POST', '/auth/logout'),
    me: () => request<CurrentUserResponse>('GET', '/auth/me'),

    listProjects: () =>
      request<{ items: ProjectSummary[]; nextCursor: string | null }>('GET', '/projects'),
    createProject: (body: CreateProjectRequest) =>
      request<ProjectSummary>('POST', '/projects', body),
    getProject: (projectId: string) =>
      request<ProjectSummary>('GET', `/projects/${encodeURIComponent(projectId)}`),

    // FR-TSK-01..09
    listTasks: (projectId: string) =>
      request<TaskListResponse>('GET', `/projects/${encodeURIComponent(projectId)}/tasks`),
    createTask: (projectId: string, body: CreateTaskRequest) =>
      request<TaskResponse>('POST', `/projects/${encodeURIComponent(projectId)}/tasks`, body),
    updateTask: (projectId: string, taskId: string, body: UpdateTaskRequest) =>
      request<TaskResponse>(
        'PATCH',
        `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
        body,
      ),
    reparentTask: (projectId: string, taskId: string, body: ReparentTaskRequest) =>
      request<TaskResponse>(
        'POST',
        `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/reparent`,
        body,
      ),
    deleteTask: (projectId: string, taskId: string, body?: DeleteTaskRequest) =>
      request<void>(
        'DELETE',
        `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`,
        body,
      ),

    // FR-CAL-01..04
    listCalendars: (projectId: string) =>
      request<CalendarListResponse>('GET', `/projects/${encodeURIComponent(projectId)}/calendars`),
    getCalendar: (projectId: string, calendarId: string) =>
      request<CalendarResponse>(
        'GET',
        `/projects/${encodeURIComponent(projectId)}/calendars/${encodeURIComponent(calendarId)}`,
      ),
    createCalendar: (projectId: string, body: CreateCalendarRequest) =>
      request<CalendarResponse>(
        'POST',
        `/projects/${encodeURIComponent(projectId)}/calendars`,
        body,
      ),
    updateCalendar: (projectId: string, calendarId: string, body: UpdateCalendarRequest) =>
      request<CalendarResponse>(
        'PATCH',
        `/projects/${encodeURIComponent(projectId)}/calendars/${encodeURIComponent(calendarId)}`,
        body,
      ),
    addCalendarException: (
      projectId: string,
      calendarId: string,
      body: CreateCalendarExceptionRequest,
    ) =>
      request<CalendarExceptionResponse>(
        'POST',
        `/projects/${encodeURIComponent(projectId)}/calendars/${encodeURIComponent(calendarId)}/exceptions`,
        body,
      ),
    removeCalendarException: (projectId: string, calendarId: string, exceptionId: string) =>
      request<void>(
        'DELETE',
        `/projects/${encodeURIComponent(projectId)}/calendars/${encodeURIComponent(calendarId)}/exceptions/${encodeURIComponent(exceptionId)}`,
      ),

    // FR-SCH-01..04
    listDependencies: (projectId: string) =>
      request<DependencyListResponse>(
        'GET',
        `/projects/${encodeURIComponent(projectId)}/dependencies`,
      ),
    createDependency: (projectId: string, body: CreateDependencyRequest) =>
      request<DependencyResponse>(
        'POST',
        `/projects/${encodeURIComponent(projectId)}/dependencies`,
        body,
      ),
    updateDependency: (projectId: string, dependencyId: string, body: UpdateDependencyRequest) =>
      request<DependencyResponse>(
        'PATCH',
        `/projects/${encodeURIComponent(projectId)}/dependencies/${encodeURIComponent(dependencyId)}`,
        body,
      ),
    deleteDependency: (projectId: string, dependencyId: string) =>
      request<void>(
        'DELETE',
        `/projects/${encodeURIComponent(projectId)}/dependencies/${encodeURIComponent(dependencyId)}`,
      ),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
