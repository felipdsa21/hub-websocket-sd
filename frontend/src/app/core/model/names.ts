// Name rules from the architecture, section 3.1.

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const DISPLAY_NAME_MAX_LENGTH = 50;

// Control characters (U+0000..U+001F, U+007F) and Unicode bidi controls, aligned with backend.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

export function hasForbiddenNameChars(value: string): boolean {
  return FORBIDDEN_NAME_CHARS.test(value);
}

export function normalizeUsername(value: string): string {
  return value.toLowerCase();
}

export function normalizeDisplayName(value: string): string {
  return value.trim();
}

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(normalizeUsername(value));
}

/** Group names follow the same rule (architecture, section 4.5). */
export function isValidDisplayName(value: string): boolean {
  if (hasForbiddenNameChars(value)) {
    return false;
  }
  const length = [...normalizeDisplayName(value)].length;
  return length >= 1 && length <= DISPLAY_NAME_MAX_LENGTH;
}
