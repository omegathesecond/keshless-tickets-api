import type { IEvent } from '@interfaces/event.interface';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface VoteWindow {
  /** When Vote activates. `null` for an unpublished event — Vote never opens
   *  before the event itself is published. */
  opensAt: Date | null;
  /** When Vote closes — always the event's start time (spec §1). */
  closesAt: Date;
  hasOpened: boolean;
  hasClosed: boolean;
}

/**
 * Vote's activation window (spec §1):
 *   - "Automatically activate Vote seven days before the event."
 *   - "If an event is published less than seven days before its start time,
 *      activate Vote immediately."
 *   - "Close voting when the event starts."
 *
 * Both rules collapse into one formula: opensAt = max(publishedAt, startTime
 * - 7 days). When the event was published well ahead of time, startTime-7d
 * is the later (binding) instant — Vote waits for T-7d as normal. When the
 * event was published inside that final week, publishedAt is later — Vote
 * opens the moment it was published, i.e. immediately, exactly as spec'd.
 *
 * `startTime`/`publishedAt` are stored as absolute UTC instants that already
 * encode the event's real local time (see @utils/eventTime.util's
 * EVENT_TIMEZONE doc comment) — plain instant arithmetic here IS "using the
 * event's configured timezone", no separate zone conversion is needed.
 */
export function getVoteWindow(event: Pick<IEvent, 'startTime' | 'publishedAt'>, now: Date = new Date()): VoteWindow {
  const closesAt = new Date(event.startTime);
  if (!event.publishedAt) {
    return { opensAt: null, closesAt, hasOpened: false, hasClosed: now.getTime() >= closesAt.getTime() };
  }
  const sevenDaysBefore = new Date(closesAt.getTime() - SEVEN_DAYS_MS);
  const opensAt = new Date(Math.max(new Date(event.publishedAt).getTime(), sevenDaysBefore.getTime()));
  return {
    opensAt,
    closesAt,
    hasOpened: now.getTime() >= opensAt.getTime(),
    hasClosed: now.getTime() >= closesAt.getTime(),
  };
}
