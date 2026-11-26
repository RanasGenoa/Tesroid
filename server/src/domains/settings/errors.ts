export type SettingsErrorCode =
  | "SETUP_ALREADY_COMPLETED"
  | "INVALID_SETUP_INPUT"
  | "INVALID_SETTINGS_UPDATE"
  | "INVALID_FAVORITE"
  | "DUPLICATE_FAVORITE_URL";

export class SettingsDomainError extends Error {
  readonly code: SettingsErrorCode;
  readonly statusCode: 400 | 403;

  constructor(code: SettingsErrorCode, message: string, statusCode: 400 | 403) {
    super(message);
    this.name = "SettingsDomainError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
