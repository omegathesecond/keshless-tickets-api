import { Types } from 'mongoose';
import { Update, IUpdate } from '@models/update.model';
import type { SocialActor } from '@utils/socialActor.util';
import { UpdateService } from '@services/update.service';
import { weekendRecapWindow } from '@utils/weekendWindow.util';

/** Rotating labels the spec calls out ("Use labels such as: Weekend Recap,
 *  Weekend Highlights, Last Night, Best Moments, What You Missed") — picked
 *  deterministically per post (stable across refetches/pagination) rather
 *  than randomized on every render. */
export const WEEKEND_RECAP_LABELS = ['Weekend Recap', 'Weekend Highlights', 'Last Night', 'Best Moments', 'What You Missed'] as const;

export function pickWeekendRecapLabel(updateId: string): string {
  let hash = 0;
  for (let i = 0; i < updateId.length; i++) hash = (hash * 31 + updateId.charCodeAt(i)) >>> 0;
  return WEEKEND_RECAP_LABELS[hash % WEEKEND_RECAP_LABELS.length]!;
}

const VISIBLE_FILTER = { category: 'weekend_recap', status: 'active', 'media.status': 'ready' } as const;

/**
 * Shortlists recent Weekend Recap posts for the Home-feed slot, excluding
 * ones already served this session (`excludeIds`, same "don't repeatedly
 * show the same content" convention as Vote's `cur.v`/Event Plan's `cur.p`).
 * `forYou` mirrors feed.service's Discover-only admin-moderation filter
 * (hiddenFromDiscoverAt) — the 'following' tab and profile/event/See-All
 * surfaces deliberately keep admin-hidden posts, same as regular updates.
 */
export async function weekendRecapCandidates(limit: number, excludeIds: string[], forYou: boolean): Promise<IUpdate[]> {
  const query: any = { ...VISIBLE_FILTER };
  if (excludeIds.length) query._id = { $nin: excludeIds.map((id) => new Types.ObjectId(id)) };
  if (forYou) query.hiddenFromDiscoverAt = null;
  // Over-fetch a recent slice so rankWeekendRecapCandidates has real Sun-Tue
  // vs. older material to boost between, then trims to `limit` after ranking.
  return Update.find(query).sort({ createdAt: -1 }).limit(Math.max(limit * 4, 20));
}

/**
 * "Prioritize Weekend Recap from Sunday through Tuesday" — posts made
 * during the CURRENT Sun-Tue window sort ahead of everything else; both
 * groups keep their incoming (most-recent-first) order.
 */
export function rankWeekendRecapCandidates(docs: IUpdate[], limit: number, now: Date = new Date()): IUpdate[] {
  const { start, end } = weekendRecapWindow(now);
  const boosted: IUpdate[] = [];
  const rest: IUpdate[] = [];
  for (const d of docs) {
    (d.createdAt >= start && d.createdAt <= end ? boosted : rest).push(d);
  }
  return [...boosted, ...rest].slice(0, limit);
}

/** Feed-slide shape for the Home feed's interleaved Weekend Recap slot —
 *  the ordinary update-slide DTO (via UpdateService.buildUpdateSlides, so
 *  it never drifts from what Discover/profile/event pages render) plus a
 *  rotating display label and the See-All entry-point flag. */
export async function buildWeekendRecapFeedSlides(docs: IUpdate[], actor: SocialActor | null): Promise<any[]> {
  const slides = await UpdateService.buildUpdateSlides(docs, actor);
  return slides.map((s) => ({ ...s, type: 'weekendRecap', label: pickWeekendRecapLabel(s.id), seeAll: true }));
}

export type WeekendRecapSort = 'recommended' | 'latest' | 'most_viewed' | 'most_liked';
export type WeekendRecapFilter = 'events' | 'vacations' | 'nightlife' | 'music' | 'food' | 'travel' | 'nearby';

const HASHTAG_FILTERS: ReadonlySet<WeekendRecapFilter> = new Set(['vacations', 'nightlife', 'music', 'food', 'travel']);

const SORTS: Record<WeekendRecapSort, Record<string, 1 | -1>> = {
  recommended: { createdAt: -1 }, // recency-boosted post-query below
  latest: { createdAt: -1 },
  most_viewed: { viewCount: -1, createdAt: -1 },
  most_liked: { likeCount: -1, createdAt: -1 },
};

/**
 * GET /api/public/weekend-recaps ("See All" page): page-based pagination
 * with sort + filter, same visibility filter and DTO as every other
 * Update listing (getTopicPosts/listByAuthor/listByEvent). Older recap
 * posts stay reachable here even after they age out of the Home-feed slot
 * ("Older recap posts may remain available on this page even after they
 * stop being featured on the Home feed").
 */
export async function listWeekendRecaps(opts: {
  page: number;
  limit: number;
  sort: WeekendRecapSort;
  filter?: WeekendRecapFilter;
}): Promise<{ docs: IUpdate[]; hasMore: boolean }> {
  const query: any = { ...VISIBLE_FILTER };
  if (opts.filter === 'events') query.eventId = { $ne: null };
  else if (opts.filter && HASHTAG_FILTERS.has(opts.filter)) query.hashtags = opts.filter;
  // 'nearby' needs a per-buyer location signal this app doesn't collect on
  // Update authorship today (see WeekendService's own documented gap) — it
  // degrades to 'latest' rather than erroring, same precedent as My Weekend's
  // nearby-ranking tier falling back when a buyer has no stored location.

  const skip = (opts.page - 1) * opts.limit;
  let cursor = Update.find(query).sort(SORTS[opts.sort]).skip(skip).limit(opts.limit + 1);
  if (opts.sort === 'recommended') {
    // Same Sun-Tue boost as the Home-feed slot, applied as a secondary sort
    // key isn't possible via a stored field, so recommended pulls a slightly
    // larger recent window and re-ranks in memory (page 1 only stays cheap;
    // deeper pages fall back to recency, which is an acceptable trade-off for
    // a "recommended" tab beyond the first screen).
    const raw = await Update.find(query).sort({ createdAt: -1 }).limit(skip + opts.limit + 1);
    const ranked = rankWeekendRecapCandidates(raw, raw.length);
    const page = ranked.slice(skip, skip + opts.limit + 1);
    return { docs: page.slice(0, opts.limit), hasMore: page.length > opts.limit };
  }
  const docs = await cursor;
  return { docs: docs.slice(0, opts.limit), hasMore: docs.length > opts.limit };
}
