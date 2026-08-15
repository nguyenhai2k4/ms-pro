import type {
  ApiError,
  CreateProjectRequest,
  CurrentUserResponse,
  LoginRequest,
  ProjectSummary,
  RegisterRequest,
  Session,
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
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
