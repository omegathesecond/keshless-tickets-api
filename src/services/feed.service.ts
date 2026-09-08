import { Types } from 'mongoose';
import { Update } from '@models/update.model';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { EventStatus } from '@interfaces/event.interface';
import { notEndedFilter } from '@utils/eventVisibility.util';
import type { SocialActor } from '@utils/socialActor.util';
import { buildEventCardFields } from '@utils/eventCard.util';

export type FeedSlide =
  | { type: 'update'; id: string; sortAt: string; [k: string]: any }
  | { type: 'event'; id: string; sortAt: string; [k: string]: any };

interface FeedOpts { tab: 'for-you' | 'following' | 'events'; cursor?: string; actor?: SocialActor; limit?: number; category?: string; }
/** `e` is the $skip-based event cursor. `s` ("seen") covers update ids already
 *  served THIS random walk — every tab with update slides ('for-you' and
 *  'following') now samples them via $sample, so a later page's $nin
 *  exclusion is what keeps it from ever repeating one. */
interface Cursor { e?: number; s?: string[]; }

function decode(cursor?: string): Cursor { if (!cursor) return {}; try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { return {}; } }
function encode(c: Cursor): string { return Buffer.from(JSON.stringify(c)).toString('base64url'); }

// per-window slot pattern (7): u u u e u u e. Only the 'following' blend and
// the 'events' tab surface event slots; 'for-you' (Discover) is posts-only, so
// its empty event bucket makes this pattern fall through to all updates.
const PATTERN: Array<'u' | 'e'> = ['u', 'u', 'u', 'e', 'u', 'u', 'e'];

export async function getFeed(opts: FeedOpts): Promise<{ items: FeedSlide[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 12, 30);
  const cur = decode(opts.cursor);

  // Discover ('for-you') is posts-only: no event cards, and no synthetic
  // "activity" FOMO interstitials (those had no other home, so they're gone
  // entirely). Events remain the substance of the 'events' tab and part of the
  // 'following' blend — so only those two tabs fetch events.
  const wantEvents = opts.tab !== 'for-you';

  // resolve follow sets for personalization/following
  let followedAuthorIds: any[] = [];
  let followedOrgIds: any[] = [];
  if (opts.actor && opts.tab === 'following') {
    const follows = await Follow.find({ followerType: opts.actor.type === 'vendor' ? 'vendor' : 'buyer', followerId: opts.actor.id }).lean();
    followedAuthorIds = follows.filter((f) => f.targetType === 'buyer').map((f) => f.targetId);
    followedOrgIds = follows.filter((f) => f.targetType === 'organizer').map((f) => f.targetId);
  }

  // Category chip filter (Discover tab). 'All' or absent = unfiltered, same
  // convention as getPublicEvents (src/controllers/public.controller.ts).
  // Resolved once up front so both the update-slide and event-slide queries
  // below can use it — update slides are restricted to the category's event
  // ids, and updates with no eventId are dropped when a category is active.
  let categoryEventIds: any[] | null = null;
  if (opts.category && opts.category !== 'All') {
    const categoryEvents = await Event.find({ status: EventStatus.PUBLISHED, ...notEndedFilter(), category: opts.category })
      .select('_id')
      .lean();
    categoryEventIds = categoryEvents.map((e) => e._id);
  }

  // ---- fetch each source (over-fetch `limit`) ----
  const updateQuery: any = { status: 'active', 'media.status': 'ready' };
  if (opts.tab === 'following') updateQuery.authorId = { $in: [...followedAuthorIds, ...followedOrgIds] };
  // Discover ('for-you') hides admin-moderated posts; `: null` also matches
  // posts predating the field (Mongo null-equality). The 'following' tab and
  // profile grids deliberately keep them — hiding is Discover-only.
  if (opts.tab === 'for-you') updateQuery.hiddenFromDiscoverAt = null;
  if (categoryEventIds) updateQuery.eventId = { $in: categoryEventIds };

  let updates: any[];
  if (opts.tab === 'events') {
    updates = [];
  } else {
    // Both 'for-you' and 'following' randomize across the ENTIRE matching
    // pool, not just a recency slice — a plain createdAt sort could only ever
    // rotate the newest posts into view. `$sample` draws uniformly from every
    // post the query matches, so a months-old post from someone you follow
    // lands in the mix exactly as often as yesterday's, and a fresh
    // mount/reload (no cursor) always re-samples the whole pool from scratch
    // — a different selection AND ordering every refresh. `s` excludes ids
    // this random walk already served so paging in never repeats one, and
    // (since it's keyed per getFeed call, not per tab) covers a session that
    // hands off from 'following' to 'for-you' too.
    const seenIds = (cur.s ?? []).map((id) => new Types.ObjectId(id));
    if (seenIds.length) updateQuery._id = { $nin: seenIds };
    updates = await Update.aggregate([{ $match: updateQuery }, { $sample: { size: limit } }]);
  }

  const eventSkip = cur.e ?? 0;
  const eventQuery: any = { status: EventStatus.PUBLISHED, ...notEndedFilter() };
  if (opts.tab === 'following') eventQuery.vendorId = { $in: followedOrgIds };
  if (opts.category && opts.category !== 'All') eventQuery.category = opts.category;
  const events = wantEvents
    ? await Event.find(eventQuery).sort({ eventDate: 1 }).skip(eventSkip).limit(limit).lean()
    : [];

  // ---- shape slides ----
  const vendorIds = [
    ...events.map((e) => e.vendorId),
    ...updates.filter((u) => u.authorType === 'vendor').map((u) => u.authorId),
  ];
  const vendors = await Vendor.find({ _id: { $in: vendorIds } }).select('businessName slug logoUrl').lean();
  const vendorMap = new Map(vendors.map((v) => [String(v._id), v]));
  const buyerIds = updates.filter((u) => u.authorType === 'buyer').map((u) => u.authorId);
  const buyers = await Buyer.find({ _id: { $in: buyerIds } }).select('username name avatarUrl').lean();
  const buyerMap = new Map(buyers.map((b) => [String(b._id), b]));

  const updateSlides: FeedSlide[] = updates.map((u) => ({
    type: 'update', id: String(u._id), sortAt: u.createdAt.toISOString(),
    kind: u.kind, caption: u.caption, media: u.media,
    likeCount: u.likeCount, saveCount: u.saveCount, shareCount: u.shareCount, viewCount: u.viewCount ?? 0,
    // `?? 0`: posts created before the counter existed have no stored field,
    // and `undefined + 1` would render NaN on the rail after the first comment.
    commentCount: u.commentCount ?? 0,
    eventId: u.eventId ? String(u.eventId) : null,
    author: u.authorType === 'vendor'
      ? { type: 'organizer', id: String(u.authorId), name: vendorMap.get(String(u.authorId))?.businessName ?? 'Organizer', avatarUrl: vendorMap.get(String(u.authorId))?.logoUrl ?? null, slug: vendorMap.get(String(u.authorId))?.slug }
      : { type: 'buyer', id: String(u.authorId), name: buyerMap.get(String(u.authorId))?.name ?? null, username: buyerMap.get(String(u.authorId))?.username ?? null, avatarUrl: buyerMap.get(String(u.authorId))?.avatarUrl ?? null },
  }));

  const eventSlides: FeedSlide[] = events.map((e) => {
    const org = vendorMap.get(String(e.vendorId));
    return {
      type: 'event', id: String(e._id), sortAt: new Date(e.eventDate).toISOString(),
      // Shared with toPublicEventCard (src/utils/eventCard.util.ts) so a new
      // event-card field can't be added there and silently miss the feed.
      ...buildEventCardFields(e),
      // `?? 0`: events predating the like counter have no stored field.
      likeCount: (e as any).likeCount ?? 0,
      organizer: org ? { id: String(e.vendorId), businessName: org.businessName, logoUrl: org.logoUrl ?? null, slug: org.slug } : null,
    };
  });

  // ---- interleave by PATTERN, dropping dry slots ----
  const q = { u: updateSlides, e: eventSlides };
  const items: FeedSlide[] = [];
  let pi = 0;
  while (items.length < limit && (q.u.length || q.e.length)) {
    const slot = PATTERN[pi % PATTERN.length] as 'u' | 'e';
    pi++;
    const bucket = q[slot];
    if (bucket.length) { items.push(bucket.shift()!); continue; }
    // slot dry: fall back to whichever has items (u > e), else break out of this pass
    const fallback = q.u.length ? q.u : q.e.length ? q.e : null;
    if (!fallback) break;
    items.push(fallback.shift()!);
  }

  // ---- next cursor from the last consumed position of each source ----
  const consumedEventCount = items.filter((i) => i.type === 'event').length;

  const next: Cursor = {};
  // Accumulate every update id served across this random walk (not just this
  // page) so a later page's $nin exclusion still covers earlier pages too.
  // The 'events' tab never produces update items, so this is a no-op there.
  const newIds = items.filter((i) => i.type === 'update').map((i) => i.id);
  const merged = [...(cur.s ?? []), ...newIds];
  if (merged.length) next.s = merged;
  if (consumedEventCount) next.e = eventSkip + consumedEventCount;
  else if (cur.e) next.e = cur.e;

  const anyMore = items.length >= limit; // conservative: only advertise more if we filled a page
  return { items, nextCursor: anyMore ? encode(next) : null };
}
