/**
 * String hashes that pick splits, feature slots and seeds. A changed hash moves rows between
 * train and test, so each is kept bit-exact with the copies it replaced.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * 32-bit FNV-1a over UTF-16 code units, unsigned. `basis` other than the FNV offset gives an
 * independent hash of the same strings (the sentry splits use two).
 */
export function fnv1a(s: string, basis = FNV_OFFSET): number {
  let h = basis;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }

  return h >>> 0;
}

/** fnv1a scaled into [0, 1), for "keep this share of rows" splits. */
export const fnv1aUnit = (s: string, basis = FNV_OFFSET) => fnv1a(s, basis) / 4294967296;

/**
 * FNV-1a over code points rather than UTF-16 code units. It equals fnv1a on text inside the
 * Basic Multilingual Plane and differs on anything beyond it (emoji), so it stays separate.
 */
export function fnv1aCodePoints(s: string): number {
  let h = FNV_OFFSET;

  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }

  return h;
}
