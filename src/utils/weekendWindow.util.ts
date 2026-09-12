export interface WeekendWindow {
  start: Date; // Friday 00:00:00.000
  end: Date; // Sunday 23:59:59.999
}

/**
 * The Fri 00:00 → Sun 23:59:59.999 window "this weekend" refers to, as of
 * `now`. Mon-Thu resolves to the UPCOMING weekend; Fri-Sun resolves to the
 * weekend already in progress (spec §19 "expire it after the weekend").
 *
 * Computed in UTC. Buyer has no stored timezone/UTC-offset field today, so
 * this is a documented approximation rather than a genuine per-user local
 * boundary — see WeekendService's doc comment for the follow-up this implies.
 */
export function currentWeekendWindow(now: Date = new Date()): WeekendWindow {
  const day = now.getUTCDay(); // 0=Sun .. 6=Sat
  // Already inside the weekend that started the most recent Friday, not
  // heading toward the next one.
  const startOffsetDays = day === 6 ? -1 : day === 0 ? -2 : (5 - day + 7) % 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + startOffsetDays, 0, 0, 0, 0));
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/** The weekend immediately following `currentWeekendWindow` — spec §19
 *  "allow users to schedule a status for a future weekend". */
export function nextWeekendWindow(now: Date = new Date()): WeekendWindow {
  const cur = currentWeekendWindow(now);
  return { start: new Date(cur.start.getTime() + 7 * 24 * 60 * 60 * 1000), end: new Date(cur.end.getTime() + 7 * 24 * 60 * 60 * 1000) };
}

export interface WeekendRecapWindow {
  start: Date; // Sunday 00:00:00.000
  end: Date; // Tuesday 23:59:59.999
}

/**
 * The Sun 00:00 → Tue 23:59:59.999 window Weekend Recap prioritization
 * refers to ("prioritize ... from Sunday through Tuesday using the user's
 * local timezone"). Same documented approximation as `currentWeekendWindow`:
 * Buyer has no stored timezone/UTC-offset field, so this is computed in UTC
 * rather than genuinely per-user local — see that function's doc comment for
 * the same unresolved follow-up.
 */
export function weekendRecapWindow(now: Date = new Date()): WeekendRecapWindow {
  const day = now.getUTCDay(); // 0=Sun .. 6=Sat; the most recent Sunday is always `now - day days`.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day, 0, 0, 0, 0));
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/** Whether `now` falls inside the current Sun-Tue Weekend Recap window. */
export function isWithinWeekendRecapWindow(now: Date = new Date()): boolean {
  const { start, end } = weekendRecapWindow(now);
  return now >= start && now <= end;
}
