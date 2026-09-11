import { Types } from 'mongoose';
import { WeekendStatus, IWeekendStatus } from '@models/weekendStatus.model';
import { WeekendRequest, IWeekendRequest } from '@models/weekendRequest.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventPlan } from '@models/eventPlan.model';
import { EventStatus } from '@interfaces/event.interface';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { FollowService } from '@services/follow.service';
import { BlockService } from '@services/block.service';
import { NearbyService, NEARBY_DEFAULT_RADIUS_KM } from '@services/nearby.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { toBuyerSummary, BuyerSummary } from '@utils/buyerSummary.util';
import { currentWeekendWindow, nextWeekendWindow } from '@utils/weekendWindow.util';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import {
  WeekendStatusType,
  WeekendAudience,
  WEEKEND_STATUS_TYPES,
  WEEKEND_AUDIENCES,
  WEEKEND_STATUS_LABELS,
  HAS_PLANS_STATUS_TYPES,
  LOOKING_FOR_PLANS_STATUS_TYPES,
  WEEKEND_MESSAGE_MAXLEN,
  WeekendRequestKind,
  WEEKEND_REQUEST_KINDS,
  WEEKEND_REQUEST_KINDS_REQUIRING_EVENT,
  WEEKEND_REQUEST_KIND_LABELS,
  WEEKEND_REQUEST_MESSAGE_MAXLEN,
} from '@interfaces/weekend.interface';

const displayName = (b: IBuyer): string => b.username ?? b.name ?? 'Someone';

export interface WeekendEventSummary {
  id: string;
  name: string;
  eventDate: Date;
  endTime: Date;
  venue: string;
  posterUrl: string | null;
}

async function loadEventSummary(eventId: Types.ObjectId | string): Promise<WeekendEventSummary | null> {
  const event = await Event.findById(eventId).select('name eventDate endTime venue posterUrl');
  if (!event) return null;
  return { id: String(event._id), name: event.name, eventDate: event.eventDate, endTime: event.endTime, venue: event.venue, posterUrl: event.posterUrl ?? null };
}

function eventSummaryFromDoc(event: any): WeekendEventSummary {
  return { id: String(event._id), name: event.name, eventDate: event.eventDate, endTime: event.endTime, venue: event.venue, posterUrl: event.posterUrl ?? null };
}

export interface WeekendStatusDto {
  id: string;
  statusType: WeekendStatusType;
  statusLabel: string;
  message: string | null;
  audience: WeekendAudience;
  event: WeekendEventSummary | null;
  /** spec §3: never inferred — only true when a genuine completed ticket
   *  transaction exists for the STATUS OWNER on the linked event. */
  hasConfirmedTicket: boolean;
  weekendStart: Date;
  weekendEnd: Date;
  updatedAt: Date;
}

async function toStatusDto(doc: IWeekendStatus): Promise<WeekendStatusDto> {
  const event = doc.eventId ? await loadEventSummary(doc.eventId) : null;
  const hasConfirmedTicket = doc.eventId
    ? Boolean(await Ticket.exists({ eventId: doc.eventId, buyerId: doc.buyerId, status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] } }))
    : false;
  return {
    id: String(doc._id),
    statusType: doc.statusType,
    statusLabel: WEEKEND_STATUS_LABELS[doc.statusType],
    message: doc.message ?? null,
    audience: doc.audience,
    event,
    hasConfirmedTicket,
    weekendStart: doc.weekendStart,
    weekendEnd: doc.weekendEnd,
    updatedAt: doc.updatedAt,
  };
}

export interface UpsertWeekendStatusInput {
  statusType: string;
  message?: string;
  eventId?: string;
  audience?: string;
  selectedViewerIds?: string[];
  forNextWeekend?: boolean;
}

export interface WeekendFeedCardDto {
  id: string;
  user: BuyerSummary;
  statusType: WeekendStatusType;
  statusLabel: string;
  message: string | null;
  event: WeekendEventSummary | null;
  otherAttendeeAvatars: (string | null)[];
  weekendStart: Date;
  weekendEnd: Date;
  updatedAt: Date;
}

export interface WeekendRequestRow {
  id: string;
  kind: WeekendRequestKind;
  status: string;
  direction: 'incoming' | 'outgoing';
  message: string | null;
  event: WeekendEventSummary | null;
  other: BuyerSummary;
  createdAt: Date;
  respondedAt: Date | null;
}

export class WeekendService {
  /**
   * Create/replace the buyer's ONE current status (spec §1/§2: "update,
   * replace or remove ... at any time"). A general status expires at the end
   * of the target weekend; an event-linked one instead stays active until
   * the event's `endTime` (spec §19) — computed here into `activeUntil` so
   * every read path is a single flat comparison.
   */
  static async upsertStatus(buyer: IBuyer, input: UpsertWeekendStatusInput): Promise<WeekendStatusDto> {
    if (!WEEKEND_STATUS_TYPES.includes(input.statusType as WeekendStatusType)) throw new HttpError(400, 'Invalid status');
    const statusType = input.statusType as WeekendStatusType;
    const audience: WeekendAudience = WEEKEND_AUDIENCES.includes(input.audience as WeekendAudience) ? (input.audience as WeekendAudience) : 'public';

    const message = input.message?.trim().slice(0, WEEKEND_MESSAGE_MAXLEN) || undefined;
    if (statusType === 'custom' && !message) throw new HttpError(400, 'A custom status needs a message');

    let selectedViewerIds: Types.ObjectId[] = [];
    if (audience === 'selected') {
      const ids = (input.selectedViewerIds ?? []).filter((id) => HEX24.test(id));
      if (ids.length === 0) throw new HttpError(400, 'Choose at least one person for "Selected People"');
      selectedViewerIds = ids.map((id) => new Types.ObjectId(id));
    }

    let event: any = null;
    if (statusType === 'going_to_event') {
      if (!input.eventId || !HEX24.test(input.eventId)) throw new HttpError(400, 'Select an upcoming event');
      event = await Event.findById(input.eventId).select('status endTime');
      if (!event) throw new HttpError(404, 'Event not found');
      if (event.endTime.getTime() <= Date.now() || event.status === EventStatus.CANCELLED) {
        throw new HttpError(400, 'That event is no longer upcoming');
      }
    }

    const { start: weekendStart, end: weekendEnd } = input.forNextWeekend ? nextWeekendWindow() : currentWeekendWindow();
    const activeUntil = event ? event.endTime : weekendEnd;

    const doc = await WeekendStatus.findOneAndUpdate(
      { buyerId: buyer._id },
      {
        $set: {
          statusType,
          message,
          eventId: statusType === 'going_to_event' ? new Types.ObjectId(input.eventId) : undefined,
          audience,
          selectedViewerIds,
          weekendStart,
          weekendEnd,
          activeUntil,
        },
        $unset: statusType === 'going_to_event' ? {} : { eventId: '' },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return toStatusDto(doc);
  }

  static async getOwnStatus(buyer: IBuyer): Promise<WeekendStatusDto | null> {
    const doc = await WeekendStatus.findOne({ buyerId: buyer._id, activeUntil: { $gt: new Date() } });
    return doc ? toStatusDto(doc) : null;
  }

  static async removeStatus(buyer: IBuyer): Promise<void> {
    await WeekendStatus.deleteOne({ buyerId: buyer._id });
  }

  /**
   * A visitor's view of `username`'s status (spec §4 audience + §20
   * privacy): blocked-either-way and any failed audience check both come
   * back as `hasStatus: false` — a viewer who isn't allowed to see it must
   * not be able to tell an active-but-hidden status apart from none at all.
   */
  static async getForViewer(viewer: IBuyer | null, username: string): Promise<{ username: string; hasStatus: boolean; status: WeekendStatusDto | null }> {
    const owner = await Buyer.findOne({ username: username.toLowerCase() }).select('username');
    if (!owner) throw new HttpError(404, 'User not found');
    const ownerId = String(owner._id);
    const isOwn = Boolean(viewer && String(viewer._id) === ownerId);

    const doc = await WeekendStatus.findOne({ buyerId: owner._id, activeUntil: { $gt: new Date() } });
    if (!doc) return { username: owner.username!, hasStatus: false, status: null };

    if (!isOwn) {
      if (viewer && (await BlockService.isBlockedEitherWay(String(viewer._id), ownerId))) {
        return { username: owner.username!, hasStatus: false, status: null };
      }
      if (doc.audience === 'only_me') return { username: owner.username!, hasStatus: false, status: null };
      if (doc.audience === 'followers') {
        const followingIds = viewer ? await FollowService.followingIds(String(viewer._id), 'buyer') : [];
        if (!viewer || !followingIds.map(String).includes(ownerId)) {
          return { username: owner.username!, hasStatus: false, status: null };
        }
      }
      if (doc.audience === 'selected') {
        if (!viewer || !doc.selectedViewerIds.map(String).includes(String(viewer._id))) {
          return { username: owner.username!, hasStatus: false, status: null };
        }
      }
    }

    return { username: owner.username!, hasStatus: true, status: await toStatusDto(doc) };
  }

  /** Buyer ids blocked in either direction from `viewerId`, for feed exclusion. */
  private static async blockedEitherWayIds(viewerId: string): Promise<string[]> {
    const [iBlocked, blockedMe] = await Promise.all([BlockService.listBlockedIds(viewerId), BlockService.listBlockerIds(viewerId)]);
    return [...iBlocked, ...blockedMe];
  }

  /** Audience filter usable directly in a Mongo query for a given viewer. */
  private static audienceOrClause(viewerId: string | null, followingIds: string[]): any[] {
    const or: any[] = [{ audience: 'public' }];
    if (viewerId) {
      or.push({ audience: 'followers', buyerId: { $in: followingIds.map((id) => new Types.ObjectId(id)) } });
      or.push({ audience: 'selected', selectedViewerIds: new Types.ObjectId(viewerId) });
    }
    return or;
  }

  /**
   * Shared assembly for both Home-feed rails (spec §5-§8): "Who Has Plans
   * This Weekend" (`HAS_PLANS_STATUS_TYPES`) and "Looking for Plans"
   * (`LOOKING_FOR_PLANS_STATUS_TYPES`) — same audience/block/rotation rules,
   * different status-type bucket, so one implementation serves both rather
   * than duplicating the ranking logic (spec asks they never mix).
   *
   * Ranking (spec §8): followed (a friend is by definition also followed —
   * see FollowService.isFriend — so this single tier covers both "follows"
   * and "friends"), then nearby (only when the viewer shares a location),
   * then everyone else — shuffled WITHIN each tier so a refresh "rotates
   * displayed users" without abandoning the priority order. `excludeIds` is
   * the caller's session "don't repeat" cursor (same shape as Vote/Plan
   * feed cards — see feed.service.ts).
   *
   * Known gap (documented, not silently wrong): spec's tier 3 — "users
   * attending events the viewer saved, followed or viewed" — has no
   * backing signal in this data model yet and is not implemented.
   */
  private static async rankedCandidates(viewer: IBuyer | null, statusTypes: WeekendStatusType[], limit: number, excludeIds: string[]): Promise<IWeekendStatus[]> {
    const viewerId = viewer ? String(viewer._id) : null;
    const now = new Date();
    const [followingIds, excludedBlocked] = await Promise.all([
      viewerId ? FollowService.followingIds(viewerId, 'buyer') : Promise.resolve([] as any[]),
      viewerId ? WeekendService.blockedEitherWayIds(viewerId) : Promise.resolve([] as string[]),
    ]);

    const query: any = {
      activeUntil: { $gt: now },
      statusType: { $in: statusTypes },
      $or: WeekendService.audienceOrClause(viewerId, followingIds.map(String)),
    };
    const excludeBuyerIds = [...(viewerId ? [viewerId] : []), ...excludedBlocked];
    if (excludeBuyerIds.length) query.buyerId = { $nin: excludeBuyerIds.map((id) => new Types.ObjectId(id)) };
    if (excludeIds.length) query._id = { $nin: excludeIds.filter((id) => HEX24.test(id)).map((id) => new Types.ObjectId(id)) };

    const overfetch = Math.max(limit * 4, limit + 10);
    const candidates = await WeekendStatus.find(query).sort({ updatedAt: -1 }).limit(overfetch);
    if (candidates.length === 0) return [];

    let nearbySet = new Set<string>();
    if (viewer?.location?.coordinates) {
      const [lng, lat] = viewer.location.coordinates;
      const nearby = await NearbyService.nearbyPeople({ type: 'buyer', id: String(viewer._id) }, lat, lng, NEARBY_DEFAULT_RADIUS_KM).catch(() => []);
      nearbySet = new Set(nearby.map((n) => n.id));
    }
    const followSet = new Set(followingIds.map(String));

    const tiers: IWeekendStatus[][] = [[], [], []];
    for (const c of candidates) {
      const id = String(c.buyerId);
      const tier = followSet.has(id) ? 0 : nearbySet.has(id) ? 1 : 2;
      tiers[tier]!.push(c);
    }
    for (const bucket of tiers) {
      for (let i = bucket.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bucket[i], bucket[j]] = [bucket[j]!, bucket[i]!];
      }
    }
    return tiers.flat().slice(0, limit);
  }

  private static async toFeedCards(candidates: IWeekendStatus[]): Promise<WeekendFeedCardDto[]> {
    if (candidates.length === 0) return [];
    const buyerIds = [...new Set(candidates.map((c) => String(c.buyerId)))];
    const eventIds = [...new Set(candidates.filter((c) => c.eventId).map((c) => String(c.eventId)))];
    const [buyers, events] = await Promise.all([
      Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl'),
      eventIds.length ? Event.find({ _id: { $in: eventIds } }).select('name eventDate endTime venue posterUrl') : Promise.resolve([] as any[]),
    ]);
    const buyerById = new Map(buyers.map((b: any) => [String(b._id), b]));
    const eventById = new Map(events.map((e: any) => [String(e._id), e]));

    // "small overlapping profile pictures of other relevant attendees" (spec
    // §6) — other buyers also publicly going to the SAME event, capped at 5.
    const otherGoingByEvent = new Map<string, (string | null)[]>();
    if (eventIds.length) {
      const others = await WeekendStatus.find({
        eventId: { $in: eventIds.map((id) => new Types.ObjectId(id)) },
        statusType: 'going_to_event',
        audience: 'public',
        activeUntil: { $gt: new Date() },
      })
        .select('eventId buyerId')
        .limit(200);
      const otherBuyerIds = [...new Set(others.map((o: any) => String(o.buyerId)))];
      const otherBuyers = await Buyer.find({ _id: { $in: otherBuyerIds } }).select('avatarUrl');
      const avatarById = new Map(otherBuyers.map((b: any) => [String(b._id), b.avatarUrl ?? null]));
      for (const o of others as any[]) {
        const key = String(o.eventId);
        const arr = otherGoingByEvent.get(key) ?? [];
        if (arr.length < 5) arr.push(avatarById.get(String(o.buyerId)) ?? null);
        otherGoingByEvent.set(key, arr);
      }
    }

    return candidates.map((c) => {
      const buyer = buyerById.get(String(c.buyerId));
      const event = c.eventId ? eventById.get(String(c.eventId)) : null;
      return {
        id: String(c._id),
        user: buyer ? toBuyerSummary(buyer) : { id: String(c.buyerId), username: null, name: null, avatarUrl: null },
        statusType: c.statusType,
        statusLabel: WEEKEND_STATUS_LABELS[c.statusType],
        message: c.message ?? null,
        event: event ? eventSummaryFromDoc(event) : null,
        otherAttendeeAvatars: c.eventId ? otherGoingByEvent.get(String(c.eventId)) ?? [] : [],
        weekendStart: c.weekendStart,
        weekendEnd: c.weekendEnd,
        updatedAt: c.updatedAt,
      };
    });
  }

  /** "Who Has Plans This Weekend" (spec §5/§6). */
  static async getWhoHasPlansCards(viewer: IBuyer | null, limit: number, excludeIds: string[]): Promise<WeekendFeedCardDto[]> {
    const candidates = await WeekendService.rankedCandidates(viewer, HAS_PLANS_STATUS_TYPES, limit, excludeIds);
    return WeekendService.toFeedCards(candidates);
  }

  /** "Looking for Plans" (spec §8, further down the feed — never mixed with the above). */
  static async getLookingForPlansCards(viewer: IBuyer | null, limit: number, excludeIds: string[]): Promise<WeekendFeedCardDto[]> {
    const candidates = await WeekendService.rankedCandidates(viewer, LOOKING_FOR_PLANS_STATUS_TYPES, limit, excludeIds);
    return WeekendService.toFeedCards(candidates);
  }

  // ---------------------------------------------------------------------
  // Private requests (spec §11-§17)
  // ---------------------------------------------------------------------

  static async createRequest(
    sender: IBuyer,
    input: { recipientId: string; kind: string; eventId?: string; eventPlanId?: string; message?: string; weekendStatusId?: string }
  ): Promise<{ id: string; status: string }> {
    if (!WEEKEND_REQUEST_KINDS.includes(input.kind as WeekendRequestKind)) throw new HttpError(400, 'Invalid request kind');
    const kind = input.kind as WeekendRequestKind;
    if (!HEX24.test(input.recipientId)) throw new HttpError(400, 'Invalid recipient');
    const recipientId = input.recipientId;
    const senderId = String(sender._id);
    if (senderId === recipientId) throw new HttpError(400, 'You cannot send this to yourself');

    const recipient = await Buyer.findById(recipientId).select('username');
    if (!recipient || !recipient.username) throw new HttpError(404, 'User not found');
    if (await BlockService.isBlockedEitherWay(senderId, recipientId)) throw new HttpError(403, 'You cannot send this request');

    let eventId: Types.ObjectId | undefined;
    if (input.eventId) {
      if (!HEX24.test(input.eventId)) throw new HttpError(400, 'Invalid event');
      const event = await Event.findById(input.eventId).select('endTime');
      if (!event || event.endTime.getTime() <= Date.now()) throw new HttpError(404, 'Event not found or already over');
      eventId = event._id;
    } else if (WEEKEND_REQUEST_KINDS_REQUIRING_EVENT.includes(kind)) {
      throw new HttpError(400, 'Select an event first');
    }

    let eventPlanId: Types.ObjectId | undefined;
    if (input.eventPlanId) {
      if (!HEX24.test(input.eventPlanId)) throw new HttpError(400, 'Invalid table/plan');
      const plan = await EventPlan.findById(input.eventPlanId).select('_id status');
      if (!plan || plan.status !== 'active') throw new HttpError(404, 'That table/plan is no longer available');
      eventPlanId = plan._id;
    }

    const message = input.message?.trim().slice(0, WEEKEND_REQUEST_MESSAGE_MAXLEN) || undefined;
    const weekendStatusId = input.weekendStatusId && HEX24.test(input.weekendStatusId) ? new Types.ObjectId(input.weekendStatusId) : undefined;

    // Idempotent: an identical still-pending ask is returned instead of piling up duplicates.
    const dupeQuery: any = { senderId, recipientId, kind, status: 'pending' };
    if (eventId) dupeQuery.eventId = eventId;
    const existing = await WeekendRequest.findOne(dupeQuery);
    if (existing) return { id: String(existing._id), status: existing.status };

    const row = await WeekendRequest.create({ senderId, recipientId, kind, eventId, eventPlanId, weekendStatusId, message });

    NotificationDispatcher.dispatchAsync(
      [recipientId],
      'weekend_request_received',
      displayName(sender),
      `${WEEKEND_REQUEST_KIND_LABELS[kind]}${message ? ': "' + message + '"' : ''}`,
      { requestId: String(row._id), kind, eventId: eventId ? String(eventId) : null, senderId },
      senderId
    );
    return { id: String(row._id), status: 'pending' };
  }

  private static async loadRequestFor(id: string, buyerId: string, role: 'sender' | 'recipient'): Promise<IWeekendRequest> {
    if (!HEX24.test(id)) throw new HttpError(400, 'Invalid request id');
    const row = await WeekendRequest.findById(id);
    if (!row) throw new HttpError(404, 'Request not found');
    const owner = role === 'recipient' ? String(row.recipientId) : String(row.senderId);
    if (owner !== buyerId) throw new HttpError(403, 'Not your request');
    return row;
  }

  static async respondToRequest(actor: IBuyer, id: string, accept: boolean): Promise<void> {
    const row = await WeekendService.loadRequestFor(id, String(actor._id), 'recipient');
    if (row.status !== 'pending') throw new HttpError(409, 'This request is no longer pending');
    const updated = await WeekendRequest.findOneAndUpdate(
      { _id: row._id, status: 'pending' },
      { $set: { status: accept ? 'accepted' : 'declined', respondedAt: new Date() } },
      { new: true }
    );
    if (!updated) return;
    NotificationDispatcher.dispatchAsync(
      [String(updated.senderId)],
      'weekend_request_responded',
      displayName(actor),
      accept ? `accepted your ask: ${WEEKEND_REQUEST_KIND_LABELS[updated.kind]}` : `declined your ask: ${WEEKEND_REQUEST_KIND_LABELS[updated.kind]}`,
      { requestId: String(updated._id), kind: updated.kind, status: updated.status },
      String(actor._id)
    );
  }

  static async cancelRequest(sender: IBuyer, id: string): Promise<void> {
    const row = await WeekendService.loadRequestFor(id, String(sender._id), 'sender');
    if (row.status !== 'pending') throw new HttpError(409, 'Only a pending request can be cancelled');
    row.status = 'cancelled';
    row.respondedAt = new Date();
    await row.save();
  }

  static async listRequests(buyer: IBuyer, status?: string): Promise<WeekendRequestRow[]> {
    const me = String(buyer._id);
    const query: any = { $or: [{ senderId: me }, { recipientId: me }] };
    if (status) query.status = status;
    const rows = await WeekendRequest.find(query).sort({ _id: -1 }).limit(100);
    if (rows.length === 0) return [];
    const otherIds = [...new Set(rows.map((r) => (String(r.recipientId) === me ? String(r.senderId) : String(r.recipientId))))];
    const eventIds = [...new Set(rows.filter((r) => r.eventId).map((r) => String(r.eventId)))];
    const [buyers, events] = await Promise.all([
      Buyer.find({ _id: { $in: otherIds } }).select('name username avatarUrl'),
      eventIds.length ? Event.find({ _id: { $in: eventIds } }).select('name eventDate endTime venue posterUrl') : Promise.resolve([] as any[]),
    ]);
    const buyerById = new Map(buyers.map((b: any) => [String(b._id), b]));
    const eventById = new Map(events.map((e: any) => [String(e._id), e]));

    return rows.map((r) => {
      const incoming = String(r.recipientId) === me;
      const otherId = incoming ? String(r.senderId) : String(r.recipientId);
      const other = buyerById.get(otherId);
      const event = r.eventId ? eventById.get(String(r.eventId)) : null;
      return {
        id: String(r._id),
        kind: r.kind,
        status: r.status,
        direction: incoming ? 'incoming' : ('outgoing' as const),
        message: r.message ?? null,
        event: event ? eventSummaryFromDoc(event) : null,
        other: other ? toBuyerSummary(other) : { id: otherId, username: null, name: null, avatarUrl: null },
        createdAt: r.createdAt,
        respondedAt: r.respondedAt ?? null,
      };
    });
  }

  /** spec §19 "remove expired or cancelled events from active plans" — a
   *  cancelled event doesn't naturally age out via `activeUntil` (its
   *  `endTime` may still be in the future), so this is the one case that
   *  needs an explicit sweep rather than a query-time filter. */
  static async sweepCancelledEventLinks(): Promise<void> {
    const linked = await WeekendStatus.find({ eventId: { $ne: null }, activeUntil: { $gt: new Date() } }).select('eventId');
    if (linked.length === 0) return;
    const eventIds = [...new Set(linked.map((l) => String(l.eventId)))];
    const cancelled = await Event.find({ _id: { $in: eventIds }, status: EventStatus.CANCELLED }).select('_id');
    if (cancelled.length === 0) return;
    await WeekendStatus.deleteMany({ eventId: { $in: cancelled.map((e) => e._id) } });
  }
}
