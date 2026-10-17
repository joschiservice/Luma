/** HTTP status a service error is reported with. */
export type ServiceErrorStatus = 401 | 403 | 404 | 409 | 422 | 503;

/** Stable error code clients receive in the error body. */
export type ServiceErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'ACCESS_SUSPENDED'
  | 'EMAIL_NOT_VERIFIED'
  | 'READ_ONLY'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'REGION_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'NOT_READY';

/**
 * An expected failure of a use case, reported to the caller with its status, code and message.
 * The HTTP error handler sends the message as written, so it must be safe and meaningful for the
 * person making the request. Unexpected failures throw ordinary errors instead.
 */
export class ServiceError extends Error {
  constructor(
    readonly statusCode: ServiceErrorStatus,
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Creates a 404 `NOT_FOUND` error for a missing or inaccessible resource; use with `throw`. */
export function notFound(message: string): ServiceError {
  return new ServiceError(404, 'NOT_FOUND', message);
}

/** Creates a 409 `CONFLICT` error for a request that contradicts current state; use with `throw`. */
export function conflict(message: string): ServiceError {
  return new ServiceError(409, 'CONFLICT', message);
}

/** Creates a 422 `VALIDATION_ERROR` error for input the use case rejects; use with `throw`. */
export function invalid(message: string): ServiceError {
  return new ServiceError(422, 'VALIDATION_ERROR', message);
}

/** Creates a 403 `FORBIDDEN` error for an action the actor may not take; use with `throw`. */
export function forbidden(message: string): ServiceError {
  return new ServiceError(403, 'FORBIDDEN', message);
}

/** Creates a 503 `SERVICE_UNAVAILABLE` error for a dependency that cannot serve now; use with `throw`. */
export function unavailable(message: string): ServiceError {
  return new ServiceError(503, 'SERVICE_UNAVAILABLE', message);
}
