export type AuthErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "LOCKED_OUT"
  | "INVALID_PIN"
  | "SETUP_REQUIRED";

export class AuthDomainError extends Error {
  readonly code: AuthErrorCode;
  readonly statusCode: 400 | 401 | 403;

  constructor(code: AuthErrorCode, message: string, statusCode: 400 | 401 | 403) {
    super(message);
    this.name = "AuthDomainError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
