/**
 * Typed errors for the R2 API. Each kind maps to a concrete HTTP status so
 * clients always receive an actionable response (spec §3).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const Errors = {
  unauthorized: (message = "Sign in is required to use cloud storage.") => new ApiError(401, "unauthorized", message),
  invalidToken: (message = "Your sign-in token is invalid. Please sign in again.") => new ApiError(401, "invalid-token", message),
  expiredToken: () => new ApiError(401, "expired-token", "Your sign-in session has expired. Please sign in again."),
  forbidden: () => new ApiError(403, "forbidden", "You do not have access to this cloud object."),
  badRequest: (message: string) => new ApiError(400, "bad-request", message),
  tooLarge: (limitBytes: number) =>
    new ApiError(413, "payload-too-large", `This file is larger than the ${Math.round(limitBytes / 1000 / 1000)} MB cloud limit.`),
  notFound: (message = "The requested cloud object does not exist.") => new ApiError(404, "not-found", message),
  uploadUnverified: (message: string) => new ApiError(409, "upload-unverified", message),
  verificationFailed: (message: string) => new ApiError(422, "verification-failed", message),
  rateLimited: () => new ApiError(429, "rate-limited", "Too many requests. Please slow down."),
  server: (message = "Cloud storage could not be reached. Please try again.") => new ApiError(502, "server-error", message),
  misconfigured: (message: string) => new ApiError(500, "misconfigured", message),
};

/** Anything thrown by the S3 client is a transient server-side problem. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error && error.name === "S3ServiceException") return Errors.server();
  return Errors.server(error instanceof Error ? error.message : String(error));
}

export type ApiResponseBody = {
  error?: { code: string; message: string };
  [key: string]: unknown;
};
