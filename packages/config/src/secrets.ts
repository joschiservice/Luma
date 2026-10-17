// Words that appear in documented sample values but not in generated random secrets.
const placeholder = /replace|placeholder|change-?me|example|your-?secret/i;

/**
 * Reports whether a configured secret is a documented placeholder or has too few distinct
 * characters to be random, such as a repeated character. Length is checked separately.
 */
export function isWeakSecret(value: string): boolean {
  return placeholder.test(value) || new Set(value).size < 10;
}
