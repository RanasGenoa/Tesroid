export const PIN_DIGITS_ONLY_REGEX = /^\d+$/;
export const PIN_VALID_REGEX = /^\d{4,8}$/;

/**
 * Validates a PIN string on the client side.
 * Returns null if valid, or a localized error message if invalid.
 */
export function validatePinInput(
  pin: string,
  options: { allowEmpty?: boolean } = {},
): string | null {
  if (pin.length === 0) {
    return options.allowEmpty ? null : 'PINコードを入力してください（半角数字4〜8桁）。';
  }
  if (!PIN_DIGITS_ONLY_REGEX.test(pin)) {
    return 'PINコードは半角数字（0〜9）のみで入力してください。';
  }
  if (!PIN_VALID_REGEX.test(pin)) {
    return 'PINコードは4〜8桁の半角数字で入力してください。';
  }
  return null;
}

/**
 * Validates partial/in-progress PIN input characters.
 * Returns null when empty or ASCII digits only; otherwise returns an error message.
 */
export function validatePinCharacters(pin: string): string | null {
  if (pin.length === 0) return null;
  if (!PIN_DIGITS_ONLY_REGEX.test(pin)) {
    return 'PINコードは半角数字（0〜9）のみで入力してください。';
  }
  return null;
}

/**
 * Updates inline PIN field error text and border highlight.
 */
export function setPinFieldError(
  inputEl: HTMLInputElement | null,
  errorEl: HTMLElement | null,
  message: string | null,
): void {
  if (errorEl) {
    errorEl.textContent = message || '';
    if (errorEl.style) {
      errorEl.style.display = message ? 'block' : 'none';
    }
  }
  if (inputEl?.style) {
    inputEl.style.borderColor = message ? 'var(--danger-color)' : '';
  }
}

/**
 * Binds real-time digit-only validation feedback to a PIN input element.
 */
export function bindPinInputValidation(
  inputEl: HTMLInputElement | null,
  errorEl: HTMLElement | null,
): void {
  if (!inputEl) return;
  inputEl.addEventListener?.('input', () => {
    setPinFieldError(inputEl, errorEl, validatePinCharacters(inputEl.value));
  });
}
