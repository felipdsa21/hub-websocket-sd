// Name rules from the architecture, section 3.1.

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const DISPLAY_NAME_MAX_LENGTH = 50;

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
  const name = normalizeDisplayName(value);
  return name.length >= 1 && name.length <= DISPLAY_NAME_MAX_LENGTH;
}
