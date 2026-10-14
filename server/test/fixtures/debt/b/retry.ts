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

export const backendCount = BACKENDS.length;
