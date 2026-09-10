import { getVoteWindow } from '@utils/voteWindow.util';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('getVoteWindow', () => {
  it('opens exactly 7 days before startTime when published well ahead of time', () => {
    const now = new Date('2026-01-15T00:00:00Z');
    const startTime = new Date('2026-01-20T00:00:00Z'); // 5 days from now
    const publishedAt = new Date('2025-12-01T00:00:00Z'); // published a month and a half ago
    const window = getVoteWindow({ startTime, publishedAt }, now);
    expect(window.opensAt).toEqual(new Date(startTime.getTime() - 7 * DAY_MS));
    expect(window.hasOpened).toBe(true); // opensAt (Jan 13) is before "now" (Jan 15)
    expect(window.hasClosed).toBe(false);
  });

  it('has not opened yet when now is still more than 7 days before startTime', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const startTime = new Date('2026-01-20T00:00:00Z'); // 19 days out
    const publishedAt = new Date('2025-12-01T00:00:00Z');
    const window = getVoteWindow({ startTime, publishedAt }, now);
    expect(window.hasOpened).toBe(false);
    expect(window.hasClosed).toBe(false);
  });

  it('activates immediately when published less than 7 days before start', () => {
    const publishedAt = new Date('2026-01-18T00:00:00Z');
    const startTime = new Date('2026-01-20T00:00:00Z'); // published only 2 days before start
    const justAfterPublish = new Date('2026-01-18T00:05:00Z');
    const window = getVoteWindow({ startTime, publishedAt }, justAfterPublish);
    expect(window.opensAt).toEqual(publishedAt); // NOT startTime - 7d (that's in the past)
    expect(window.hasOpened).toBe(true);
  });

  it('closes exactly at startTime', () => {
    const startTime = new Date('2026-01-20T00:00:00Z');
    const publishedAt = new Date('2025-12-01T00:00:00Z');
    const atStart = getVoteWindow({ startTime, publishedAt }, startTime);
    expect(atStart.hasClosed).toBe(true);
    const justBefore = getVoteWindow({ startTime, publishedAt }, new Date(startTime.getTime() - 1));
    expect(justBefore.hasClosed).toBe(false);
  });

  it('never opens for an unpublished event', () => {
    const startTime = new Date('2026-01-20T00:00:00Z');
    const window = getVoteWindow({ startTime, publishedAt: undefined }, new Date('2026-01-19T00:00:00Z'));
    expect(window.opensAt).toBeNull();
    expect(window.hasOpened).toBe(false);
  });
});
