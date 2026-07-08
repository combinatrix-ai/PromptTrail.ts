/**
 * Human-friendly duration parsing for durable timers (`Agent.sleep`).
 *
 * Supports a plain number of milliseconds or a compact string built from
 * `<amount><unit>` segments, e.g. `'7d'`, `'2h30m'`, `'90s'`, `'1w'`, `'500ms'`.
 * Whitespace between segments is allowed (`'1h 30m'`). The whole string must be
 * consumed — an unrecognized unit or trailing garbage throws so a typo in an
 * authored `sleep('7dd')` is a hard error rather than a silently-truncated wait.
 *
 * Intentionally dependency-free: durable timers live in core, and pulling a date
 * library in for a one-file parser is not worth the surface area.
 */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

// Ordered longest-first so `ms` is matched before `m`.
const SEGMENT_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*/;

/**
 * Parse a duration into milliseconds.
 *
 * @throws if `input` is a negative/non-finite number, an empty string, or a
 * string that is not fully consumed by `<amount><unit>` segments.
 */
export function parseDuration(input: number | string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(
        `Invalid duration ${input}: expected a non-negative, finite number of milliseconds.`,
      );
    }
    return input;
  }
  const original = input;
  let rest = input.trim();
  if (rest === '') {
    throw new Error('Invalid duration "": expected e.g. "7d", "2h30m", "90s".');
  }
  let total = 0;
  let matchedAny = false;
  while (rest.length > 0) {
    const match = SEGMENT_RE.exec(rest);
    if (!match) {
      throw new Error(
        `Invalid duration "${original}": expected e.g. "7d", "2h30m", "90s".`,
      );
    }
    total += Number(match[1]) * UNIT_MS[match[2]];
    rest = rest.slice(match[0].length);
    matchedAny = true;
  }
  if (!matchedAny) {
    throw new Error(
      `Invalid duration "${original}": expected e.g. "7d", "2h30m", "90s".`,
    );
  }
  return total;
}
