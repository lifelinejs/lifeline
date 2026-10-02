// Small date helpers. Pure functions, no clock of their own: "today" is
// passed in so tests do not change meaning tomorrow.

/** Milliseconds in a day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Days from today until an `eol` date.
 *
 * A negative answer means the date has passed. Both dates are compared in UTC
 * so the number does not change with the reader's time zone.
 *
 * @param {string | null | undefined} eol A YYYY-MM-DD string, or nothing.
 * @param {Date} [now] "Today". Defaults to the real clock.
 * @returns {number | null} Whole days, or null when there is no usable date.
 */
export function daysUntilEol(eol, now = new Date()) {
  if (!eol) {
    return null;
  }
  const target = Date.parse(`${eol}T00:00:00Z`);
  if (Number.isNaN(target)) {
    return null;
  }
  // Start of today in UTC, so the count is whole days, not "24 hours ago".
  const startOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return Math.round((target - startOfToday) / MS_PER_DAY);
}
