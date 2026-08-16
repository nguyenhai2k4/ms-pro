import type { ApiErrorCode, DependencyCycleDetails } from '@projectapp/shared-types';
import { HTTP_STATUS_BY_ERROR_CODE } from '@projectapp/shared-types';

/**
 * One error type, one envelope. Handlers throw; the error handler in `app.ts` renders. Endpoints
 * that build their own error responses drift, and the drift shows up as a client that has to
 * special-case each route.
 */
export class ApiException extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiException';
    this.code = code;
    this.status = HTTP_STATUS_BY_ERROR_CODE[code];
    this.details = details;
  }
}

export const unauthenticated = (message = 'Authentication required'): ApiException =>
  new ApiException('unauthenticated', message);

export const forbidden = (message = 'You do not have permission to do that'): ApiException =>
  new ApiException('forbidden', message);

/**
 * FR-AUTH-04: an entity in another organization must be indistinguishable from one that does not
 * exist. Returning `forbidden` here would confirm that some other organization holds that id.
 */
export const notFound = (message = 'Not found'): ApiException =>
  new ApiException('not_found', message);

export const validationFailed = (details: unknown, message = 'Request failed validation') =>
  new ApiException('validation_failed', message, details);

export const conflict = (message: string): ApiException => new ApiException('conflict', message);

/**
 * FR-SCH-03: the dependency edit would close a loop. Distinct from `conflict` (which shares its
 * 409) because the client renders it differently — `details` names the exact path and arrows, so
 * "A -> B -> C -> A" can be highlighted instead of a generic failure toast. `details` must satisfy
 * `dependencyCycleDetailsSchema`; the caller parses it through that schema rather than this
 * function taking `unknown` and hoping.
 */
export const dependencyCycle = (
  details: DependencyCycleDetails,
  message = 'That link would create a dependency cycle',
): ApiException => new ApiException('dependency_cycle', message, details);
