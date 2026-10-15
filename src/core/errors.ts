export type ErrorCode =
  | "invalid_input"
  | "authentication"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "conflict"
  | "provider_error"
  | "network_error"
  | "invalid_response";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status_code?: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}
