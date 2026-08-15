import type { Task } from '@projectapp/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { ApiClient } from '../api/client.js';

/**
 * Shared fixtures for `apps/web/src/tasks` component tests. Not itself a `*.test.ts` file, so
 * `vitest run` does not try to execute it as a suite.
 */

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

export function withQueryClient(ui: ReactElement): ReactElement {
  return <QueryClientProvider client={makeQueryClient()}>{ui}</QueryClientProvider>;
}

/**
 * A fully-stubbed `ApiClient`: every method is a `vi.fn()` so a test only has to configure the
 * calls it cares about, and any unexpected call is still type-safe (never `any`) and visible in
 * `vi.fn()`'s call log if a test wants to assert against it.
 */
export function createMockApi(overrides: Partial<ApiClient> = {}): ApiClient {
  // The task endpoints default to a resolved value rather than a bare `vi.fn()`: `useMutation`
  // awaits whatever `mutationFn` returns, and every test in this directory exercises one of these
  // through a real `useMutation`/`useQuery`, not by calling the mock directly.
  const base: ApiClient = {
    register: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    listTasks: vi.fn().mockResolvedValue({ tasks: [] }),
    createTask: vi.fn().mockResolvedValue({ task: makeTask() }),
    updateTask: vi.fn().mockResolvedValue({ task: makeTask() }),
    reparentTask: vi.fn().mockResolvedValue({ task: makeTask() }),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    listCalendars: vi.fn(),
    getCalendar: vi.fn(),
    createCalendar: vi.fn(),
    updateCalendar: vi.fn(),
    addCalendarException: vi.fn(),
    removeCalendarException: vi.fn(),
  };
  return { ...base, ...overrides };
}

const baseTask: Task = {
  id: 't1',
  projectId: 'p1',
  parentId: null,
  wbsCode: '1',
  name: 'Excavate',
  durationHours: 8,
  start: '2026-09-01T08:00:00.000Z',
  finish: '2026-09-01T16:00:00.000Z',
  pctComplete: 0,
  isMilestone: false,
  scheduleMode: 'auto',
  constraintType: 'ASAP',
  constraintDate: null,
  calendarId: null,
  priority: 500,
  status: 'not_started',
  actualStart: null,
  actualFinish: null,
  notes: '',
  createdAt: '2026-09-01T08:00:00.000Z',
  updatedAt: '2026-09-01T08:00:00.000Z',
  updatedBy: 'u1',
} as unknown as Task;

/**
 * `id`/`parentId` are branded (`packages/shared-types/src/primitives.ts`), which is exactly the
 * class of bug the brand exists to catch in real code — but a test fixture legitimately wants to
 * hand it a plain string task id, so the override bag is loosely typed and the merge is cast once
 * here rather than at every call site.
 */
export function makeTask(overrides: Record<string, unknown> = {}): Task {
  return { ...baseTask, ...overrides } as unknown as Task;
}
