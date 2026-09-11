import { Types } from 'mongoose';
import { Update } from '@models/update.model';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { EventReaction } from '@models/eventReaction.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { EventStatus } from '@interfaces/event.interface';
import { notEndedFilter } from '@utils/eventVisibility.util';
import type { SocialActor } from '@utils/socialActor.util';
import { buildEventCardFields } from '@utils/eventCard.util';
import { getVoteFeedCard } from '@services/vote.service';
import { EventPlanService } from '@services/eventPlan.service';

export type FeedSlide =
  | { type: 'update'; id: string; sortAt: string; [k: string]: any }
  | { type: 'event'; id: string; sortAt: string; [k: string]: any }
  | { type: 'vote'; id: string; sortAt: string; [k: string]: any }
  | { type: 'plan'; id: string; sortAt: string; [k: string]: any };

interface FeedOpts { tab: 'for-you' | 'following' | 'events'; cursor?: string; actor?: SocialActor; limit?: number; category?: string; }
/** `e` is the $skip-based event cursor. `s` ("seen") covers update ids already
 *  served THIS random walk — every tab with update slides ('for-you' and
 *  'following') now samples them via $sample, so a later page's $nin
 *  exclusion is what keeps it from ever repeating one. `v` ("vote-seen") is
 *  the Home feed spec's "don't repeatedly show the same Vote during one
 *  browsing session" (§4) — event ids whose Vote card has already been
 *  served THIS session, across every tab that shows one. `p` ("plan-seen")
 *  is the same "don't repeat" treatment for Event Plan cards. */
interface Cursor { e?: number; s?: string[]; v?: string[]; p?: string[]; }

function decode(cursor?: string): Cursor { if (!cursor) return {}; try { return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { return {}; } }
function encode(c: Cursor): string { return Buffer.from(JSON.stringify(c)).toString('base64url'); }

type Slot = 'u' | 'e' | 'v' | 'p';

// per-window slot pattern (11): mostly posts, an event every ~4th slot, a
// Vote card once every 11, and an Event Plan card once every 11 — "mix ...
// cards naturally... without overwhelming the feed" (spec §4, extended to
// Event Plan cards by the Home-feed-discoverability follow-up). Only the
// 'following' blend and the 'events' tab surface event slots; 'for-you'
// (Discover) is posts-only, so its empty event bucket makes this pattern
// fall through to updates/votes/plans. The vote and plan buckets are
// themselves only ever populated for 'for-you'/'following' (see getFeed),
// so they're no-op dry slots on the 'events' tab.
//
// The window's slot ORDER is re-shuffled every time one is generated (not a
// fixed constant) — the Home feed follow-up spec: "do not use a fixed feed
// position for Vote cards" / "vary their position whenever the feed is
// refreshed" (extended to Event Plan cards for the same reason: neither
// should camp on a fixed position). Each getFeed() call builds its pattern
// buffer from scratch, so a fresh load/refresh (no cursor) always
// re-randomizes from slot 0.
function shuffledWindow(): Slot[] {
  const tokens: Slot[] = ['u', 'u', 'u', 'u', 'u', 'u', 'u', 'e', 'e', 'v', 'p'];
  for (let i = tokens.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = tokens[i]!;
    tokens[i] = tokens[j]!;
    tokens[j] = tmp;
  }
  return tokens;
}

/**
 * Appends one freshly-shuffled window to the interleave pattern buffer, with
 * guards so "continue displaying normal posts before and after each
 * Vote/Event Plan card" still holds despite the randomness: (1) never let a
 * 'v' or 'p' land right after the previous window's trailing slot of the
 * SAME type and (2) on a session's very first window, never put either in
 * slot 0 — the literal top of a fresh feed load ("do not always display the
 * Vote card at the top of the Home feed").
 */
function appendWindow(pattern: Slot[], isFreshLoad: boolean): void {
  const win = shuffledWindow();
  const isFirstWindow = pattern.length === 0;
  const prevTail = pattern[pattern.length - 1];
  for (const special of ['v', 'p'] as const) {
    if (win[0] !== special) continue;
    if (!(prevTail === special || (isFirstWindow && isFreshLoad))) continue;
    const swapIdx = win.findIndex((t, idx) => idx > 0 && t !== 'v' && t !== 'p');
    if (swapIdx > 0) {
      const tmp = win[0]!;
      win[0] = win[swapIdx]!;
      win[swapIdx] = tmp;
    }
  }
  pattern.push(...win);
}

/**
 * Up to `limit` events whose Vote is currently open, soonest-closing first —
 * a Mongo-provable equivalent of "window has opened and not closed" (see
 * @utils/voteWindow.util's doc comment: for ANY published event, that holds
 * exactly when `now < startTime <= now + 7d`), so no per-row window
 * computation is needed just to shortlist candidates.
 */
async function voteCandidateEvents(limit: number, excludeEventIds: string[]): Promise<any[]> {
  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const query: any = { status: EventStatus.PUBLISHED, publishedAt: { $ne: null }, startTime: { $gt: now, $lte: sevenDaysOut } };
  if (excludeEventIds.length) query._id = { $nin: excludeEventIds.map((id) => new Types.ObjectId(id)) };
  return Event.find(query).sort({ startTime: 1 }).limit(limit).lean();
}

/**
 * "Prioritize Votes for events the user follows, saved, joined, purchased
 * tickets for or has previously engaged with" (spec §4). Scores each
 * candidate by how many of those signals apply and stable-sorts by score
 * (ties keep the soonest-closing order from voteCandidateEvents). A no-op for
 * an anonymous viewer — there's no engagement history to rank by.
 */
async function rankVoteCandidates(events: any[], actor?: SocialActor): Promise<any[]> {
  if (!actor || events.length === 0) return events;
  const eventIds = events.map((e) => e._id);

  const [reactions, follows, memberships, ticketPhones] = await Promise.all([
    EventReaction.find({ eventId: { $in: eventIds }, actorType: actor.type, buyerId: actor.id }).select('eventId').lean(),
    Follow.find({ followerType: actor.type === 'vendor' ? 'vendor' : 'buyer', followerId: actor.id, targetType: 'organizer' }).select('targetId').lean(),
    actor.type === 'buyer'
      ? Community.find({ eventId: { $in: eventIds } }).select('eventId').lean().then(async (communities) => {
          if (communities.length === 0) return [] as string[];
          const joined = await Membership.find({ communityId: { $in: communities.map((c: any) => c._id) }, buyerId: actor.id }).select('communityId').lean();
          const joinedCommunityIds = new Set(joined.map((m: any) => String(m.communityId)));
          return communities.filter((c: any) => joinedCommunityIds.has(String(c._id))).map((c: any) => String(c.eventId));
        })
      : Promise.resolve([] as string[]),
    actor.type === 'buyer' ? Buyer.findById(actor.id).select('phone').lean().then((b: any) => (b?.phone ? [b.phone] : [])) : Promise.resolve([] as string[]),
  ]);

  const engagedEventIds = new Set(reactions.map((r: any) => String(r.eventId)));
  const followedOrgIds = new Set(follows.map((f: any) => String(f.targetId)));
  const joinedEventIds = new Set(memberships as string[]);
  const ticketedEventIds = new Set(
    ticketPhones.length
      ? (await Ticket.find({ eventId: { $in: eventIds }, customerPhone: { $in: ticketPhones }, status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] } }).select('eventId').lean()).map(
          (t: any) => String(t.eventId)
        )
      : []
  );

  const score = (e: any): number => {
    const id = String(e._id);
    let s = 0;
    if (engagedEventIds.has(id)) s++;
    if (e.vendorId && followedOrgIds.has(String(e.vendorId))) s++;
    if (joinedEventIds.has(id)) s++;
    if (ticketedEventIds.has(id)) s++;
    return s;
  };
  return [...events].sort((a, b) => score(b) - score(a)); // stable: ties keep incoming (soonest-closing) order
}

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

  // Vote cards (spec §4) — only the two personal-scroll tabs; 'events' is
  // dedicated event browsing and gets none (see shuffledWindow's doc
  // comment). "Don't repeatedly show the same Vote during one session" is
  // `cur.v` (accumulated below, same mechanism as for-you's `s`); a small
  // over-fetch (2x the pattern's per-page budget) covers ranking + any
  // candidate whose window closed between the shortlist query and
  // getVoteFeedCard.
  const voteSlides: FeedSlide[] = [];
  if (opts.tab === 'for-you' || opts.tab === 'following') {
    const voteBudget = Math.max(1, Math.ceil(limit / 11));
    const candidates = await rankVoteCandidates(await voteCandidateEvents(voteBudget * 2, cur.v ?? []), opts.actor);
    for (const candidate of candidates) {
      if (voteSlides.length >= voteBudget) break;
      const card = await getVoteFeedCard(candidate, opts.actor ?? null);
      if (card) voteSlides.push({ type: 'vote', id: card.eventId, sortAt: new Date(candidate.startTime).toISOString(), ...card });
    }
  }

  // Event Plan cards (Home-feed-discoverability follow-up to spec §5) —
  // same two personal-scroll tabs as Vote. getFeedCards is a live
  // visibility='public'/status='active' query (src/services/eventPlan.service.ts),
  // so a plan the admin just made private or cancelled is already excluded —
  // no separate ranking/window-closed race to guard against, unlike Vote.
  // `cur.p` gives the same "don't repeat this session" treatment as `cur.v`.
  const planSlides: FeedSlide[] = [];
  if (opts.tab === 'for-you' || opts.tab === 'following') {
    const planBudget = Math.max(1, Math.ceil(limit / 11));
    const viewerBuyerId = opts.actor?.type === 'buyer' ? opts.actor.id : null;
    const cards = await EventPlanService.getFeedCards(planBudget, cur.p ?? [], viewerBuyerId);
    for (const card of cards) planSlides.push(card as FeedSlide);
  }

  // ---- interleave by a freshly-shuffled pattern, dropping dry slots ----
  const q = { u: updateSlides, e: eventSlides, v: voteSlides, p: planSlides };
  const items: FeedSlide[] = [];
  const pattern: Slot[] = [];
  const isFreshLoad = !opts.cursor;
  let pi = 0;
  while (items.length < limit && (q.u.length || q.e.length || q.v.length || q.p.length)) {
    if (pi >= pattern.length) appendWindow(pattern, isFreshLoad);
    const slot = pattern[pi]!;
    pi++;
    const bucket = q[slot];
    if (bucket.length) { items.push(bucket.shift()!); continue; }
    // slot dry: fall back to whichever has items (u > e > v > p), else break out of this pass
    const fallback = q.u.length ? q.u : q.e.length ? q.e : q.v.length ? q.v : q.p.length ? q.p : null;
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

  const consumedVoteEventIds = items.filter((i) => i.type === 'vote').map((i) => i.id);
  const mergedVoteSeen = [...(cur.v ?? []), ...consumedVoteEventIds];
  if (mergedVoteSeen.length) next.v = mergedVoteSeen;

  const consumedPlanIds = items.filter((i) => i.type === 'plan').map((i) => i.id);
  const mergedPlanSeen = [...(cur.p ?? []), ...consumedPlanIds];
  if (mergedPlanSeen.length) next.p = mergedPlanSeen;

  const anyMore = items.length >= limit; // conservative: only advertise more if we filled a page
  return { items, nextCursor: anyMore ? encode(next) : null };
}
