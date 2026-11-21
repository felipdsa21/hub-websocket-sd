import {
  DISPLAY_NAME_MAX_LENGTH,
  hasForbiddenNameChars,
  isValidDisplayName,
  isValidUsername,
} from './names';

describe('names validation', () => {
  it('accepts valid display and group names after trimming spaces', () => {
    expect(isValidDisplayName('Ana Maria')).toBe(true);
    expect(isValidDisplayName('  Equipe SD  ')).toBe(true);
    expect(isValidDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH))).toBe(true);
    expect(isValidDisplayName('😀'.repeat(DISPLAY_NAME_MAX_LENGTH))).toBe(true);
  });

  it('rejects empty, overlong, control and bidi characters in display and group names', () => {
    expect(isValidDisplayName('')).toBe(false);
    expect(isValidDisplayName('   ')).toBe(false);
    expect(isValidDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toBe(false);
    expect(isValidDisplayName('😀'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toBe(false);
    for (const invalid of [
      'Ana\u0000Bia',
      'Ana\tBia',
      'Ana\nBia',
      'Ana\rBia',
      'Ana\u001fBia',
      'Ana\u007fBia',
      'Ana\u202aBia',
      'Ana\u202eBia',
      'Ana\u2066Bia',
      'Ana\u2069Bia',
      '\t',
    ]) {
      expect(hasForbiddenNameChars(invalid)).toBe(true);
      expect(isValidDisplayName(invalid)).toBe(false);
    }
  });

  it('validates usernames case-insensitively without spaces or forbidden punctuation', () => {
    expect(isValidUsername('Marina.Alves_1-2')).toBe(true);
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('marina alves')).toBe(false);
    expect(isValidUsername('marina:1')).toBe(false);
  });
});
