import { z } from 'zod';

/**
 * The REST envelope. Every non-2xx response from `apps/api` has this shape, so the client has
 * exactly one error path to handle rather than one per endpoint.
 */

export const apiErrorCodeSchema = z.enum([
  /** No valid session (FR-AUTH-03). */
  'unauthenticated',
  /** Authenticated, but the role lacks the permission (FR-ACL-01..05). */
  'forbidden',
  /**
   * Entity absent, or present but outside the caller's organization. FR-AUTH-04 requires
   * cross-org access to look identical to absence — a `forbidden` here would confirm that some
   * other organization holds that id.
   */
  'not_found',
  /** Request body failed its zod schema. `details` carries the flattened issues. */
  'validation_failed',
  /** Optimistic-concurrency or uniqueness conflict. */
  'conflict',
  /**
   * FR-SCH-03: the dependency edit would introduce a cycle. `details.cyclePath` names it, and
   * no partial state is committed.
   */
  'dependency_cycle',
  /**
   * FR-COL-02: the write lost a last-write-wins race. The client is told, with the winning
   * value, rather than the change being dropped silently.
   */
  'superseded',
  'rate_limited',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  /** Human-readable, safe to surface. Never contains credential material or SQL. */
  message: z.string(),
  details: z.unknown().optional(),
  /** Correlates to the OpenTelemetry trace for this request. */
  requestId: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  dependency_cycle: 409,
  superseded: 409,
  rate_limited: 429,
  internal: 500,
});

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
