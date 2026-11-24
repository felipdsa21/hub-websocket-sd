// Name rules from the architecture, section 3.1.

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
export const DISPLAY_NAME_MAX_LENGTH = 50;

// Controls, line and paragraph separators and format characters (bidi controls, zero-width spaces),
// except the joiners that emoji sequences and some scripts need. Aligned with backend.
const FORBIDDEN_NAME_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/u;
// A character that is neither blank nor ignorable, unlike the Hangul filler.
const VISIBLE_NAME_CHAR = /[^\s\p{Default_Ignorable_Code_Point}]/u;

export function hasForbiddenNameChars(value: string): boolean {
  return FORBIDDEN_NAME_CHARS.test(value);
}

export function hasVisibleNameChar(value: string): boolean {
  return VISIBLE_NAME_CHAR.test(value);
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
  const name = normalizeDisplayName(value);
  return [...name].length <= DISPLAY_NAME_MAX_LENGTH && hasVisibleNameChar(name);
}
