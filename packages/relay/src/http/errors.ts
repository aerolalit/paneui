export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

export const errors = {
  unauthorized: () => new ApiError(401, "unauthorized"),
  forbidden: (code = "forbidden", message?: string) =>
    new ApiError(403, code, message),
  notFound: () => new ApiError(404, "not_found"),
  invalidRequest: (message?: string, details?: unknown) =>
    new ApiError(400, "invalid_request", message, details),
  payloadTooLarge: () => new ApiError(413, "payload_too_large"),
  tooManyRequests: (message?: string) =>
    new ApiError(429, "rate_limited", message),
  conflict: (message?: string) => new ApiError(409, "conflict", message),
  gone: (message = "session is closed") => new ApiError(410, "gone", message),
  schemaViolation: (code: string, details?: unknown) =>
    new ApiError(422, code, undefined, details),
};
