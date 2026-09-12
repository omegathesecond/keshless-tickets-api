import { Types } from 'mongoose';
import { Update, IUpdate } from '@models/update.model';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { currentWeekendWindow } from '@utils/weekendWindow.util';
import { WHATS_HOT_CATEGORIES, WhatsHotCategory } from '@/constants/whatsHotCategories';
import { HEX24 } from '@utils/controllerHelpers.util';

export type WhatsHotSort = 'recommended' | 'latest' | 'most-viewed' | 'most-liked';
export type WhatsHotFilter = WhatsHotCategory | 'All' | 'Nearby';

/** How many preview cards ride in one Home-feed "What's Hot" slide (spec:
 *  "horizontally scrollable preview with a See All option" — a handful of
 *  cards, not the whole section). */
export const FEED_SLIDE_SIZE = 8;
export const SEE_ALL_DEFAULT_LIMIT = 20;
export const SEE_ALL_MAX_LIMIT = 50;

/** A dateless post (no specific activity time) reads as "Don't Miss This"
 *  once it's picked up enough engagement to earn the stronger label;
 *  otherwise it's the plain "This Weekend" default (spec §4 label list). */
const DONT_MISS_ENGAGEMENT_THRESHOLD = 20;

export interface WhatsHotEventSummary {
  id: string;
  name: string;
  eventDate: string;
  venue: string;
  posterUrl: string | null;
  /** Mirrors Event.ticketing — "Show Buy Ticket when the attached event
   *  supports Carrot ticket sales" (spec §4). */
  canBuyTicket: boolean;
}

export interface WhatsHotAuthor {
  type: 'organizer' | 'buyer';
  id: string;
  name: string | null;
  username?: string | null;
  avatarUrl: string | null;
  slug?: string;
}

export interface WhatsHotCard {
  type: 'hot-item';
  id: string;
  kind: 'video' | 'image';
  caption: string;
  media: IUpdate['media'];
  mediaCount: number;
  author: WhatsHotAuthor;
  venue: string | null;
  hotCategory: WhatsHotCategory | null;
  activityDate: string | null;
  label: string;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  event: WhatsHotEventSummary | null;
  createdAt: string;
}

/**
 * "This Weekend" / "Starts Tomorrow" / "Weekend Loading" / "Don't Miss
 * This" (spec §4's label examples). Purely a function of activityDate vs
 * `now` (day-granularity, UTC — same documented approximation
 * currentWeekendWindow already carries) with an engagement-based fallback
 * for dateless posts, so it's always fresh on read — never stored, so a
 * post's label can't go stale between fetches.
 */
export function computeLabel(update: Pick<IUpdate, 'activityDate' | 'likeCount' | 'commentCount' | 'viewCount'>, now: Date = new Date()): string {
  if (update.activityDate) {
    const activity = new Date(update.activityDate);
    const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const startOfActivityDay = Date.UTC(activity.getUTCFullYear(), activity.getUTCMonth(), activity.getUTCDate());
    const daysUntil = Math.round((startOfActivityDay - startOfToday) / 86_400_000);
    if (daysUntil <= 0) return 'This Weekend';
    if (daysUntil === 1) return 'Starts Tomorrow';
    return 'Weekend Loading';
  }
  const engagement = (update.likeCount ?? 0) + (update.commentCount ?? 0) + (update.viewCount ?? 0);
  return engagement >= DONT_MISS_ENGAGEMENT_THRESHOLD ? "Don't Miss This" : 'This Weekend';
}

/**
 * "Stop presenting the content as upcoming" once its weekend has ended
 * (spec §8) — anchored on activityDate when the post has one, else on when
 * it was posted. Same documented UTC-approximation tradeoff
 * currentWeekendWindow already carries (Buyer has no stored timezone).
 * The post itself is never touched by this — it just stops qualifying for
 * the rail/See All feed; it stays exactly where it always was on the
 * creator's profile (see update.controller's unrelated listByAuthor, which
 * never filters on `feature`).
 */
export function isEligible(update: Pick<IUpdate, 'activityDate' | 'createdAt'>, now: Date = new Date()): boolean {
  const anchor = update.activityDate ?? update.createdAt;
  return now.getTime() <= currentWeekendWindow(anchor).end.getTime();
}

/** Generous Mongo-provable upper bound so the exact per-doc isEligible()
 *  check only has to run over a small candidate set — currentWeekendWindow
 *  never reaches more than 6 days behind its anchor and its window is at
 *  most 3 days wide, so nothing anchored over 9 days ago could still pass. */
function notObviouslyExpiredFilter(now: Date) {
  const cutoff = new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000);
  return { $or: [{ activityDate: { $gte: cutoff } }, { activityDate: null, createdAt: { $gte: cutoff } }] };
}

function baseQuery(now: Date): Record<string, unknown> {
  return { feature: 'whats-hot', status: 'active', 'media.status': 'ready', ...notObviouslyExpiredFilter(now) };
}

async function hydrate(updates: any[], now: Date): Promise<WhatsHotCard[]> {
  if (updates.length === 0) return [];
  const vendorIds = updates.filter((u) => u.authorType === 'vendor').map((u) => u.authorId);
  const buyerIds = updates.filter((u) => u.authorType === 'buyer').map((u) => u.authorId);
  const eventIds = [...new Set(updates.filter((u) => u.eventId).map((u) => String(u.eventId)))];

  const [vendors, buyers, events] = await Promise.all([
    Vendor.find({ _id: { $in: vendorIds } }).select('businessName slug logoUrl').lean(),
    Buyer.find({ _id: { $in: buyerIds } }).select('username name avatarUrl').lean(),
    eventIds.length ? Event.find({ _id: { $in: eventIds } }).select('name eventDate venue posterUrl ticketing').lean() : Promise.resolve([] as any[]),
  ]);
  const vendorMap = new Map(vendors.map((v: any) => [String(v._id), v]));
  const buyerMap = new Map(buyers.map((b: any) => [String(b._id), b]));
  const eventMap = new Map(events.map((e: any) => [String(e._id), e]));

  return updates.map((u) => {
    const author: WhatsHotAuthor =
      u.authorType === 'vendor'
        ? {
            type: 'organizer',
            id: String(u.authorId),
            name: vendorMap.get(String(u.authorId))?.businessName ?? 'Organizer',
            avatarUrl: vendorMap.get(String(u.authorId))?.logoUrl ?? null,
            slug: vendorMap.get(String(u.authorId))?.slug,
          }
        : {
            type: 'buyer',
            id: String(u.authorId),
            name: buyerMap.get(String(u.authorId))?.name ?? null,
            username: buyerMap.get(String(u.authorId))?.username ?? null,
            avatarUrl: buyerMap.get(String(u.authorId))?.avatarUrl ?? null,
          };
    const event = u.eventId ? eventMap.get(String(u.eventId)) : null;
    return {
      type: 'hot-item' as const,
      id: String(u._id),
      kind: u.kind,
      caption: u.caption,
      media: u.media,
      mediaCount: u.media?.length ?? 0,
      author,
      venue: u.venue ?? null,
      hotCategory: u.hotCategory ?? null,
      activityDate: u.activityDate ? new Date(u.activityDate).toISOString() : null,
      label: computeLabel(u, now),
      likeCount: u.likeCount ?? 0,
      commentCount: u.commentCount ?? 0,
      viewCount: u.viewCount ?? 0,
      event: event
        ? {
            id: String(event._id),
            name: event.name,
            eventDate: new Date(event.eventDate).toISOString(),
            venue: event.venue,
            posterUrl: event.posterUrl ?? null,
            canBuyTicket: (event.ticketing ?? 'carrot') === 'carrot',
          }
        : null,
      createdAt: new Date(u.createdAt).toISOString(),
    };
  });
}

/**
 * Up to `limit` eligible What's Hot posts for one Home-feed slide,
 * soonest-happening first (dateless posts trail, ranked by engagement) —
 * excludes ids already shown this feed session (`excludeIds`, mirrors
 * Vote/Event Plan's session "don't repeat" cursors). Returns null when
 * nothing qualifies, so feed.service can treat it as a dry slot exactly
 * like an empty Vote/Plan bucket.
 */
export async function getFeedSlide(excludeIds: string[], limit: number = FEED_SLIDE_SIZE, now: Date = new Date()): Promise<{ items: WhatsHotCard[] } | null> {
  if (limit <= 0) return null;
  const query: any = baseQuery(now);
  if (excludeIds.length) query._id = { $nin: excludeIds.filter((id) => HEX24.test(id)).map((id) => new Types.ObjectId(id)) };

  const candidates = await Update.find(query).sort({ createdAt: -1 }).limit(limit * 3).lean();
  const eligible = candidates.filter((u) => isEligible(u, now));
  if (eligible.length === 0) return null;

  eligible.sort((a: any, b: any) => {
    const aDate = a.activityDate ? new Date(a.activityDate).getTime() : Infinity;
    const bDate = b.activityDate ? new Date(b.activityDate).getTime() : Infinity;
    if (aDate !== bDate) return aDate - bDate;
    const aScore = (a.likeCount ?? 0) + (a.commentCount ?? 0) + (a.viewCount ?? 0);
    const bScore = (b.likeCount ?? 0) + (b.commentCount ?? 0) + (b.viewCount ?? 0);
    return bScore - aScore;
  });

  return { items: await hydrate(eligible.slice(0, limit), now) };
}

export interface SeeAllOpts {
  category?: WhatsHotFilter;
  sort?: WhatsHotSort;
  cursor?: string;
  limit?: number;
}
export interface SeeAllResult {
  items: WhatsHotCard[];
  nextCursor: string | null;
}

const SORT_FIELD: Record<WhatsHotSort, 'createdAt' | 'viewCount' | 'likeCount'> = {
  recommended: 'createdAt',
  latest: 'createdAt',
  'most-viewed': 'viewCount',
  'most-liked': 'likeCount',
};

interface Cursor { v: number; id: string }
function decodeCursor(raw?: string): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    return typeof c?.v === 'number' && typeof c?.id === 'string' ? c : null;
  } catch {
    return null;
  }
}
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

/**
 * The dedicated See All page (spec §7): category filter + sort, paginated.
 * 'Nearby' shows every category (proximity, not a stored field, is the
 * differentiator) — Carrot has no venue geo-coordinates today (Event.venue
 * is free text, unlike Buyer's opt-in `location` point used by
 * @services/nearby.service for PEOPLE), so it degrades to the same
 * ordering as Recommended rather than faking a distance sort. Documented
 * limitation, not a silent fallback: it's still real, current, eligible
 * content — just not distance-ranked yet.
 *
 * Paginates over up to 3 rounds of over-fetching so an ineligible
 * (expired-since-query) run of candidates can't starve a page below
 * `limit` while eligible items still exist further in the collection.
 */
export async function getSeeAll(opts: SeeAllOpts): Promise<SeeAllResult> {
  const now = new Date();
  const limit = Math.min(Math.max(1, opts.limit ?? SEE_ALL_DEFAULT_LIMIT), SEE_ALL_MAX_LIMIT);
  const sort = opts.sort ?? 'recommended';
  const field = SORT_FIELD[sort];
  const direction = -1; // newest/most-viewed/most-liked first, always descending

  const query: any = baseQuery(now);
  if (opts.category && opts.category !== 'All' && opts.category !== 'Nearby' && (WHATS_HOT_CATEGORIES as readonly string[]).includes(opts.category)) {
    query.hotCategory = opts.category;
  }

  // createdAt is a BSON Date; viewCount/likeCount are plain numbers. Mongo's
  // comparison operators don't coerce across BSON types, so the cursor's
  // stored epoch-ms `v` must be converted back to a real Date before it's
  // used to filter a Date field — comparing a Date field against a bare
  // number would silently match nothing (BSON type ordering puts every Date
  // above every Number), breaking pagination outright.
  const isDateField = field === 'createdAt';
  const toFieldValue = (v: number) => (isDateField ? new Date(v) : v);

  const cursor = decodeCursor(opts.cursor);
  const items: any[] = [];
  let lastRaw: { v: number; id: string } | null = cursor;
  let exhausted = false;

  for (let round = 0; round < 3 && items.length <= limit && !exhausted; round++) {
    const roundQuery = { ...query };
    if (lastRaw) {
      roundQuery.$and = [
        ...(roundQuery.$or ? [{ $or: roundQuery.$or }] : []),
        { $or: [{ [field]: { $lt: toFieldValue(lastRaw.v) } }, { [field]: toFieldValue(lastRaw.v), _id: { $lt: new Types.ObjectId(lastRaw.id) } }] },
      ];
      delete roundQuery.$or;
    }
    const page = await Update.find(roundQuery).sort({ [field]: direction, _id: direction }).limit(limit * 2).lean();
    if (page.length === 0) { exhausted = true; break; }
    const last = page[page.length - 1]!;
    lastRaw = { v: new Date((last as any)[field] ?? 0).getTime() || (last as any)[field] || 0, id: String(last._id) };
    if (page.length < limit * 2) exhausted = true;
    items.push(...page.filter((u) => isEligible(u, now)));
  }

  const page = items.slice(0, limit);
  const hasMore = items.length > limit || !exhausted;
  const cards = await hydrate(page, now);
  const nextCursor = hasMore && page.length > 0 ? encodeCursor({ v: (() => { const v = (page[page.length - 1] as any)[field]; return v instanceof Date ? v.getTime() : v; })(), id: String(page[page.length - 1]!._id) }) : null;
  return { items: cards, nextCursor };
}
