/**
 * Purpose: debt-audit fixture — a TypeScript file carrying two deferral
 * markers, one in the shortcut: <limit>, <when to upgrade> form and one
 * plain FIXME whose text repeats in deploy.sh. Never imported; read by
 * audit-debt.test.ts line by line.
 * Author(s): John Reed
 */

// Constants
const BACKENDS = ["primary"];

// Retry wrapper
export function withRetry<T>(fn: () => T): T {
  // shortcut: retry count hard-coded to 3, upgrade when a second backend ships
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      // FIXME: the timeout path is unhandled
    }
  }
  throw last;
}

// A marker written to break a shell line: a double quote, a semicolon and a
// backtick in one comment (#390). It must travel as one argument, verbatim.
// HACK: keep the "legacy" path; see `echo pwned` for why
export const backendCount = BACKENDS.length;
