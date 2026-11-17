export function normalizeName(raw: string): string | null {
  // Go unicode.IsSpace and Unicode White_Space; do not use JS trim (includes BOM).
  if (/[\p{Cc}\u2028\u2029\uD800-\uDFFF]/u.test(raw)) return null
  const name = raw.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
  const count = Array.from(name).length
  return count >= 1 && count <= 30 ? name : null
}
