import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Joi from 'joi';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketService } from '@services/ticket.service';
import { SalesChannel, PaymentStatus } from '@interfaces/ticket.interface';
import { BuyerAuthService } from '@services/buyerAuth.service';
import { normalizePhone } from '@utils/phone.util';
import { notEndedFilter } from '@utils/eventVisibility.util';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { PeachClient } from '@services/payments/peach.client';
import { DeltapayClient } from '@services/payments/deltapay.client';
import { YocoClient } from '@services/payments/yoco.client';
import { YeboPayClient } from '@services/payments/yebopay.client';
import { ContactMessage } from '@models/contactMessage.model';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { getViewerEventReactions } from '@services/eventReaction.service';
import { CalendarService } from '@services/calendar.service';
import { GoingService } from '@services/going.service';
import { buildEventCards } from '@services/eventCards.service';
import { toPublicEventCard } from '@/utils/eventCard.util';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Update } from '@models/update.model';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { MAX_TICKETS_PER_ORDER } from '@utils/serviceFee.util';
import { normalizeHashtag } from '@utils/hashtags.util';
import { UpdateController } from '@controllers/update.controller';
import { getViewerReactions } from '@services/update.service';
import { getActivityFeed } from '@services/activityFeed';
import { blendedRecentSales, RECENT_SALES_WINDOW_MS as RECENT_WINDOW_MS } from '@utils/recentSales.util';

// Re-exported so existing importers (e.g. the recentSales.test.ts suite) of
// `blendedRecentSales` from this controller keep working — the shared logic
// itself now lives in recentSales.util (also used by eventCards.service, to
// avoid a controller<->service circular import).
export { blendedRecentSales };

// Lookback window for the trending-hashtags rail (TopicsPage): only updates
// posted in the last 14 days count toward a hashtag's volume, so the rail
// reflects current conversation rather than all-time totals.
const TRENDING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const TRENDING_LIMIT = 15;
const TRENDING_HOT_COUNT = 3;

// Privacy-preserving display name for the public activity feed. Turns a stored
// buyer name into "Sipho D." — first name + last initial — so we can create
// social proof from REAL purchases without broadcasting anyone's full name or
// phone. Unknown/blank names become "Someone" (honest — we don't invent one).
function maskBuyerName(name?: string): string {
  const cleaned = (name || '').trim().replace(/\s+/g, ' ');
  if (!cleaned) return 'Someone';
  const parts = cleaned.split(' ');
  const first = parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1);
  if (parts.length === 1) return first;
  return `${first} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`;
}

// Pool of Eswatini/Swazi first names used to synthesize social-proof buyers for
// the public "live" ticker. Kept in the same "First L." masked shape the real
// feed uses, so fabricated entries are visually indistinguishable from genuine
// masked sales.
const FAKE_FIRST_NAMES = [
  'Sipho', 'Thabo', 'Nomsa', 'Lindiwe', 'Mandla', 'Bongani', 'Zanele', 'Dumisani',
  'Nkosana', 'Thandi', 'Sibusiso', 'Nolwazi', 'Musa', 'Ayanda', 'Sifiso', 'Nonhlanhla',
  'Bhekithemba', 'Gcina', 'Phindile', 'Sanele', 'Menzi', 'Themba', 'Khanya', 'Lwazi',
  'Simphiwe', 'Sizwe', 'Vusi', 'Wandile', 'Xolani', 'Zodwa', 'Busisiwe', 'Celiwe',
  'Fikile', 'Hlengiwe', 'Jabulani', 'Lungile', 'Mbali', 'Ntombi', 'Precious', 'Qhawe',
  'Rethabile', 'Tshepo', 'Velaphi', 'Wenzile', 'Grace', 'Faith', 'Blessing', 'Melusi',
  'Nokuthula', 'Sethabile',
];
const FAKE_LAST_INITIALS = 'ABDGHKLMNPSTVWZ'.split('');

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// A single fabricated masked name, e.g. "Thabo M." — matches maskBuyerName output.
function randomMaskedName(): string {
  return `${randomFrom(FAKE_FIRST_NAMES)} ${randomFrom(FAKE_LAST_INITIALS)}.`;
}

// Quantity distribution skewed toward small buys (most people grab 1–2 tickets).
function randomQuantity(): number {
  const r = Math.random();
  if (r < 0.55) return 1;
  if (r < 0.8) return 2;
  if (r < 0.92) return randomFrom([3, 4]);
  return randomFrom([5, 6, 8]);
}

// Synthesize `count` fabricated recent-purchase entries, each pinned to one of
// the supplied REAL published events (we invent the buyer, never the event, so
// eventId/eventName stay valid). soldAt values are spread across the last ~8h
// so the client ticker shows a natural mix of "just now / 14m ago / 3h ago".
// Returns [] when there are no events to attach activity to.
function generateFakeActivity(
  events: Array<{ _id: any; name: string }>,
  count: number,
): Array<{ name: string; quantity: number; eventId: string; eventName: string; soldAt: Date }> {
  if (events.length === 0) return [];
  const now = Date.now();
  const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
  return Array.from({ length: count }, () => {
    const evt = randomFrom(events);
    return {
      name: randomMaskedName(),
      quantity: randomQuantity(),
      eventId: String(evt._id),
      eventName: evt.name,
      soldAt: new Date(now - Math.floor(Math.random() * EIGHT_HOURS_MS)),
    };
  });
}

// Validation schema for the public "Contact Support" form.
const contactMessageSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  email: Joi.string().trim().lowercase().email().max(200).required(),
  subject: Joi.string().trim().min(1).max(150).required(),
  message: Joi.string().trim().min(1).max(5000).required(),
});

// Validation schema for Peach card purchase initiation
/**
 * The cart a buyer is checking out: one entry per tier, 1..20 lines.
 *
 * MAX_TICKETS_PER_ORDER caps the WHOLE cart, not each line — otherwise the
 * order limit could be exceeded by splitting across tiers, the same hole the
 * per-account cap has (see resolveCart). Shared by every purchase rail so no
 * two of them can disagree about what a valid cart is.
 */
const cartItemsSchema = Joi.array()
  .items(Joi.object({
    ticketTypeId: Joi.string().hex().length(24).required(),
    quantity: Joi.number().integer().min(1).max(MAX_TICKETS_PER_ORDER).required(),
  }))
  .min(1)
  .max(20)
  .custom((value: Array<{ quantity: number }>, helpers) => {
    const total = value.reduce((sum, l) => sum + l.quantity, 0);
    if (total > MAX_TICKETS_PER_ORDER) {
      return helpers.message({ custom: `You can buy at most ${MAX_TICKETS_PER_ORDER} tickets per order` } as never);
    }
    return value;
  })
  .required();

const cardInitiateSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  items: cartItemsSchema,
  customerName: Joi.string().max(100).optional(),
});

// Validation schema for DeltaPay hosted-checkout purchase initiation.
// Same shape as card: DeltaPay collects the payer identifier on its own page.
const deltapayInitiateSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  items: cartItemsSchema,
  customerName: Joi.string().max(100).optional(),
});

// Validation schema for Yoco hosted-checkout purchase initiation.
// Same shape as card: Yoco collects the card details on its own page.
const yocoInitiateSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  items: cartItemsSchema,
  customerName: Joi.string().max(100).optional(),
});

// Validation schema for YeboPay hosted-checkout purchase initiation.
// Same shape as the other card rails: YeboPay collects the card details on its
// own hosted page, so Carrot never sees them.
const yebopayInitiateSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  items: cartItemsSchema,
  customerName: Joi.string().max(100).optional(),
});

// Validation schema for MTN MoMo purchase initiation
const momoInitiateSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  items: cartItemsSchema,
  customerName: Joi.string().max(100).optional(),
  momoPhone: Joi.string().pattern(/^[0-9]{8,15}$/).required(),
});

// Free-ticket claim — no payment fields at all (a free tier has nothing to
// charge). The tier being genuinely free is enforced SERVER-SIDE in
// TicketService.claimFreeTicket, never from this body; the quantity cap here
// is just defence-in-depth parity with the paid paths.
const freeClaimSchema = Joi.object({
  eventId: Joi.string().hex().length(24).required(),
  items: cartItemsSchema,
  customerName: Joi.string().max(100).optional().allow(''),
});

// Validation schemas
// Exported so it's independently unit-testable (see
// __tests__/eventQuery.validator.test.ts) without spinning up the DB harness.
export const publicEventsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
  search: Joi.string().optional().max(100),
  startDate: Joi.date().iso().optional(),
  // `min(startDate)` only applies when startDate is ALSO present — an
  // endDate-only query (what the Past tab sends) must not 400 trying to
  // resolve a ref to a field that isn't there.
  endDate: Joi.date().iso().optional().when('startDate', {
    is: Joi.exist(),
    then: Joi.date().iso().min(Joi.ref('startDate')),
  }),
  // Category chip filter (Home/Discover). 'All' or absent = unfiltered — see
  // getPublicEvents. Not constrained to EVENT_CATEGORIES so an unrecognized
  // value just yields zero results rather than a 400.
  category: Joi.string().optional().max(50)
});

// Validation schema for GET /api/public/topics/:tag/posts — page-based
// pagination (not the cursor convention used by updates/by and
// updates/for-event), matching what the BUILD spec for this endpoint asked
// for and mirroring the clamp used by publicEventsQuerySchema.
export const topicPostsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
});

const publicPurchaseSchema = Joi.object({
  eventId: Joi.string().required().regex(/^[0-9a-fA-F]{24}$/),
  items: cartItemsSchema,
  // The buyer's phone is NO LONGER taken from the body — it comes from the
  // OTP-verified buyer token (req.ticketsUser.userPhone). This guarantees
  // every ticket is tied to a phone the buyer actually controls, so it always
  // surfaces under "My Tickets" for that number. Name stays optional for
  // personalising the printed ticket.
  customerName: Joi.string().optional().max(100).trim().allow(''),
  keshlessCardNumber: Joi.string().required().length(8).alphanum().uppercase(),
  keshlessPin: Joi.string().optional().length(4).pattern(/^\d{4}$/)
});

export class PublicController {
  /**
   * Resolve the public-safe organizer identity for an event's vendor.
   * NEVER include email/phone/keshlessVendorId — this is a public surface.
   * Missing or inactive vendors resolve to null rather than throwing: a
   * broken/removed organizer must never break the public event page.
   */
  private static async resolveOrganizer(
    vendorId: unknown
  ): Promise<{ id: string; businessName: string; logoUrl: string | null } | null> {
    if (!vendorId) return null;
    try {
      const vendor = await Vendor.findById(vendorId).select('businessName logoUrl isActive').lean();
      if (!vendor || !vendor.isActive) return null;
      return {
        id: String(vendor._id),
        businessName: vendor.businessName,
        logoUrl: vendor.logoUrl ?? null,
      };
    } catch (error) {
      console.error('Resolve public organizer error:', error);
      return null;
    }
  }

  /**
   * GET /api/public/calendar?year= — every published event in the year,
   * grouped by month. The public "what's on" calendar: listing an event puts
   * it here for everyone, immediately.
   *
   * Auth is OPTIONAL (optionalTicketsAuth). A signed-in buyer's rows carry
   * `viewerIsGoing` / `viewerHasSaved` so the client can mark their own —
   * marking only, never filtering. Signed-out visitors get the same calendar
   * with both flags absent. Contrast /api/social/me/calendar, which is the
   * personal going+saved calendar and requires auth.
   */
  static async getPublicCalendar(req: Request, res: Response): Promise<any> {
    try {
      const yearRaw = req.query['year'];
      const year = yearRaw === undefined ? new Date().getUTCFullYear() : Number(yearRaw);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return ApiResponseUtil.error(res, 'year must be a 4-digit year', 400);
      }

      const { monthCounts, eventIds } = await CalendarService.publicForYear(year);

      // A viewer is optional here, so both lookups degrade to "no marks"
      // rather than failing the calendar — but an anonymous request never
      // attempts them in the first place.
      const buyer = await resolveBuyerFromRequest(req).catch(() => null);
      const actor = buyer ? { type: 'buyer' as const, id: String(buyer._id) } : null;
      const goingEventIds = buyer ? new Set(await GoingService.goingEventIds(buyer)) : undefined;

      const events = await buildEventCards(eventIds, actor, { ...(goingEventIds ? { goingEventIds } : {}) });
      return ApiResponseUtil.success(res, { monthCounts, events });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load the calendar');
    }
  }

  /**
   * Get all published events (no auth required)
   */
  static async getPublicEvents(req: Request, res: Response): Promise<any> {
    try {
      // Validate query
      const { error, value } = publicEventsQuerySchema.validate(req.query);
      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const { page, limit, search, startDate, endDate, category } = value;

      // Build query - only published events
      const filter: any = {
        status: EventStatus.PUBLISHED
      };

      // Category chip filter (Home/Discover). 'All' or absent means
      // unfiltered — every published event stays in the result set.
      if (category && category !== 'All') {
        filter.category = category;
      }

      // Filter by date range
      if (startDate || endDate) {
        filter.eventDate = {};
        if (startDate) filter.eventDate.$gte = new Date(startDate);
        if (endDate) filter.eventDate.$lte = new Date(endDate);
      } else {
        // Default: show every event that hasn't ended yet, so an in-progress
        // event (e.g. a late-night show) stays discoverable and buyable until
        // its endTime — not just until its start instant. See notEndedFilter.
        Object.assign(filter, notEndedFilter());
      }

      // Search by name, venue, or description
      if (search) {
        filter.$or = [
          { name: { $regex: search, $options: 'i' } },
          { venue: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ];
      }

      // Execute query with pagination
      const skip = (page - 1) * limit;
      const [events, total] = await Promise.all([
        Event.find(filter)
          .select('name description venue eventDate startTime endTime posterUrl thumbnailUrl ticketTypes capacity totalTicketsSold vendorId likeCount ticketing externalTicketUrl category priceMin priceMax currency galleryImages')
          .sort({ eventDate: 1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Event.countDocuments(filter)
      ]);

      // Real recent-sales momentum for trending badges: sum completed (non-
      // wristband) ticket quantities per event over the last 48h. One
      // aggregation over just the events on this page. "trending" is the top
      // few by momentum (with a real floor of >=2), so a badge only ever
      // reflects genuine recent activity — never a fabricated signal.
      const eventIds = events.map(e => e._id);
      const since = new Date(Date.now() - RECENT_WINDOW_MS);
      const recentAgg = await TicketSale.aggregate([
        {
          $match: {
            eventId: { $in: eventIds },
            paymentStatus: PaymentStatus.COMPLETED,
            channel: { $ne: SalesChannel.WRISTBAND },
            soldAt: { $gte: since },
          },
        },
        { $group: { _id: '$eventId', recent: { $sum: '$quantity' } } },
      ]);
      const recentMap = new Map<string, number>(recentAgg.map((a: any) => [String(a._id), a.recent]));
      const trendingIds = new Set(
        [...recentMap.entries()]
          .filter(([, n]) => n >= 2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id]) => id),
      );

      // Batch-resolve organizer identity for the page in ONE query (same
      // public-safe shape + null-on-missing/inactive semantics as
      // resolveOrganizer for the detail endpoint). Wrapped so a vendor lookup
      // failure never breaks the public events list — it just degrades to no
      // organizer badges, loudly logged.
      type PublicOrganizer = { id: string; businessName: string; logoUrl: string | null };
      const organizerMap = new Map<string, PublicOrganizer>();
      try {
        const uniqueVendorIds = [...new Set(events.map(e => e.vendorId).filter(Boolean).map(id => String(id)))];
        if (uniqueVendorIds.length > 0) {
          const vendors = await Vendor.find({ _id: { $in: uniqueVendorIds }, isActive: true })
            .select('businessName logoUrl')
            .lean();
          for (const vendor of vendors) {
            organizerMap.set(String(vendor._id), {
              id: String(vendor._id),
              businessName: vendor.businessName,
              logoUrl: vendor.logoUrl ?? null,
            });
          }
        }
      } catch (error) {
        console.error('Batch resolve public organizers error:', error);
      }

      // "Have I liked/saved this?" for the heart + bookmark on each card.
      // Anonymous visitors have no actor, so every event reports
      // viewerHasLiked/viewerHasSaved:false and both render hollow — the
      // endpoint stays public either way. One batch query for the page,
      // mirroring how the Discover feed hydrates its event slides (see
      // feed.controller).
      const actor = await resolveActorFromRequest(req).catch(() => null);
      let likedMap: Record<string, { liked: boolean; saved: boolean }> = {};
      if (actor) {
        try {
          likedMap = await getViewerEventReactions(eventIds.map(String), actor);
        } catch (error) {
          // Degrade to "not liked/saved" rather than 500 the whole list — but say so.
          console.error('Batch resolve viewer event reactions error:', error);
        }
      }

      // Transform events for public display. `filter` above already scopes
      // this whole query to status: EventStatus.PUBLISHED, so every event here
      // is already published/active — safe to apply the synthetic+real blend
      // (item #19) to all of them.
      const publicEvents = events.map((event: any) => toPublicEventCard(event, {
        recentSales: blendedRecentSales(recentMap.get(String(event._id)) || 0, String(event._id)),
        trending: trendingIds.has(String(event._id)),
        organizer: event.vendorId ? (organizerMap.get(String(event.vendorId)) ?? null) : null,
        // `?? 0`: events predating the counter have no stored field, and
        // .lean() does not apply the schema default to an absent path.
        likeCount: (event as any).likeCount ?? 0,
        viewerHasLiked: likedMap[String(event._id)]?.liked ?? false,
        viewerHasSaved: likedMap[String(event._id)]?.saved ?? false,
      }));

      return ApiResponseUtil.success(res, {
        events: publicEvents,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1
        }
      });
    } catch (error: any) {
      console.error('Get public events error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch events');
    }
  }

  /**
   * GET /api/public/events/live
   * Published events currently in progress ([startTime, endTime] contains
   * "now"), for the Home "Live Now" rail. Each card carries `liveAttendees` —
   * a REAL count of active (non-banned) community members, never a
   * fabricated number. Sorted by startTime so the show that started earliest
   * (most likely furthest into its run) leads.
   */
  static async getLiveEvents(_req: Request, res: Response): Promise<any> {
    try {
      const now = new Date();
      const events = await Event.find({
        status: EventStatus.PUBLISHED,
        startTime: { $lte: now },
        endTime: { $gte: now },
      })
        .sort({ startTime: 1 })
        .lean();

      const communities = await Community.find({ eventId: { $in: events.map((e) => e._id) } })
        .select('_id eventId')
        .lean();
      const communityIdByEvent = new Map(communities.map((c) => [String(c.eventId), c._id]));

      const cards = await Promise.all(
        events.map(async (event: any) => {
          const communityId = communityIdByEvent.get(String(event._id));
          const liveAttendees = communityId
            ? await Membership.countDocuments({ communityId, bannedAt: { $exists: false } })
            : 0;
          return { ...toPublicEventCard(event), liveAttendees };
        }),
      );

      return ApiResponseUtil.success(res, { events: cards });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load live events');
    }
  }

  /**
   * GET /api/public/activity
   * Recent purchase activity across published events, for the public "live"
   * FOMO ticker. The feed blends REAL completed sales with SYNTHETIC
   * social-proof entries so the ticker always feels busy and varied: fabricated
   * buyers ("Thabo M.") are attached to real published events (we never invent
   * events, only buyers), with timestamps spread across the last few hours.
   * Buyer identity on real sales is reduced server-side to "Sipho D." so full
   * names/phones never leave the API. Zero-amount wristband batches are
   * excluded. Real and synthetic items are merged, sorted newest-first, and
   * capped at the limit.
   */
  static async getActivity(req: Request, res: Response): Promise<any> {
    try {
      const requested = parseInt(String(req.query['limit'] ?? '15'), 10);
      const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 15, 1), 30);

      // Over-fetch, then keep only sales whose event is currently published
      // (the populate `match` nulls out the rest), then slice to the limit.
      const raw = await TicketSale.find({
        paymentStatus: PaymentStatus.COMPLETED,
        channel: { $ne: SalesChannel.WRISTBAND },
      })
        .sort({ soldAt: -1 })
        .limit(limit * 4)
        .select('customerName quantity soldAt eventId')
        .populate({ path: 'eventId', select: 'name status', match: { status: EventStatus.PUBLISHED } })
        .lean();

      const real = raw
        .filter((s: any) => s.eventId)
        .map((s: any) => ({
          name: maskBuyerName(s.customerName),
          quantity: s.quantity,
          eventId: String(s.eventId._id),
          eventName: s.eventId.name,
          soldAt: s.soldAt,
        }));

      // Pull real published events to anchor the fabricated entries to, then
      // synthesize a full limit's worth of fake buys spread across all of them.
      const publishedEvents = await Event.find({ status: EventStatus.PUBLISHED })
        .select('name')
        .limit(60)
        .lean();
      const fake = generateFakeActivity(publishedEvents as any, limit);

      const activity = [...real, ...fake]
        .sort((a: any, b: any) => new Date(b.soldAt).getTime() - new Date(a.soldAt).getTime())
        .slice(0, limit);

      return ApiResponseUtil.success(res, { activity });
    } catch (error: any) {
      console.error('Get activity error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch activity');
    }
  }

  /**
   * GET /api/public/activity-feed
   * The Activity page: real social activity across the platform — likes,
   * follows, going, posts, event announcements and new signups — newest first.
   *
   * NOT to be confused with getActivity above, which powers the homepage
   * ticker and deliberately blends synthetic purchases. This endpoint is
   * real-only and shares no code with it.
   */
  static async getActivityFeed(req: Request, res: Response): Promise<any> {
    try {
      const tabParam = String(req.query['tab'] ?? 'everyone');
      if (tabParam !== 'everyone' && tabParam !== 'following') {
        return ApiResponseUtil.error(res, 'tab must be "everyone" or "following"', 400);
      }

      let viewer: { type: 'buyer' | 'vendor'; id: string } | undefined;
      if (tabParam === 'following') {
        // resolveActorFromRequest (not resolveBuyerFromRequest) so a
        // signed-in VENDOR/brand session resolves too — the service
        // explicitly supports vendor viewers on this tab (see
        // activityFeed/index.ts), and the website treats a brand session as
        // signed-in, so it always calls this tab expecting a real answer.
        const actor = await resolveActorFromRequest(req);
        // The following tab cannot be answered without a viewer — say so
        // loudly rather than silently degrading to the everyone tab. This
        // check MUST stay here, before the service call: the service throws
        // for tab "following" with no viewer, and the controller must never
        // rely on catching that.
        if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in to see who you follow');
        viewer = actor;
      }

      const cursor = req.query['cursor'] ? String(req.query['cursor']) : undefined;
      // A non-numeric ?limit= (e.g. "abc") must not 500: Number('abc') is NaN,
      // which is neither null nor undefined so the service's `?? 30` default
      // never substitutes for it, and NaN poisons Math.max/Math.min in the
      // service's clamp, reaching Mongoose's .limit()/$limit as NaN — Mongo
      // rejects that and the whole request 500s. Only pass a finite number
      // through; anything else falls back to undefined so the service applies
      // its own default/clamp (limit=0 and huge limits are already handled
      // correctly there and are covered by tests below).
      const rawLimit = req.query['limit'] !== undefined ? Number(req.query['limit']) : undefined;
      const limit = rawLimit !== undefined && Number.isInteger(rawLimit) ? rawLimit : undefined;

      const result = await getActivityFeed({ tab: tabParam, cursor, limit, viewer });
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      // Log the real error server-side, but never let the feed service's
      // detailed invariant-violation messages (they name internal source
      // keys and timestamps — see activityFeed/index.ts) reach an
      // unauthenticated client verbatim.
      console.error('Get activity feed error:', error);
      return ApiResponseUtil.error(res, 'Failed to fetch activity');
    }
  }

  /**
   * GET /api/public/trending
   * Trending hashtags for the TopicsPage rail. Aggregates REAL, currently
   * visible updates (active status, ready media) from the last 14 days,
   * ranks tags by post volume, and returns the top 15. The top 3 by rank are
   * flagged `hot` — no fabricated data, an empty result is just `[]`.
   */
  static async getTrending(_req: Request, res: Response): Promise<any> {
    try {
      const since = new Date(Date.now() - TRENDING_WINDOW_MS);
      const agg = await Update.aggregate([
        {
          $match: {
            status: 'active',
            'media.status': 'ready',
            createdAt: { $gte: since },
            hashtags: { $ne: [] },
          },
        },
        { $unwind: '$hashtags' },
        { $group: { _id: '$hashtags', posts: { $sum: 1 } } },
        { $sort: { posts: -1 } },
        { $limit: TRENDING_LIMIT },
      ]);

      // A representative thumbnail per tag: the newest visible post carrying
      // it, so the vertical trending list shows a real image (image url, or a
      // video's poster) rather than a bare hashtag. Same visibility window and
      // filters as the count aggregation — a tag with no ready media just gets
      // image:null, never a fabricated one.
      const topTags = agg.map((row: any) => row._id as string);
      const thumbAgg = topTags.length
        ? await Update.aggregate([
            {
              $match: {
                status: 'active',
                'media.status': 'ready',
                createdAt: { $gte: since },
                hashtags: { $in: topTags },
              },
            },
            { $sort: { createdAt: -1 } },
            { $unwind: '$hashtags' },
            { $match: { hashtags: { $in: topTags } } },
            { $group: { _id: '$hashtags', media: { $first: '$media' } } },
          ])
        : [];
      const thumbByTag = new Map<string, string | null>(
        thumbAgg.map((row: any) => [row._id as string, row.media?.[0]?.image?.url ?? row.media?.[0]?.video?.poster ?? null]),
      );

      const trending = agg.map((row: any, index: number) => ({
        tag: row._id as string,
        posts: row.posts as number,
        hot: index < TRENDING_HOT_COUNT,
        image: thumbByTag.get(row._id as string) ?? null,
      }));

      return ApiResponseUtil.success(res, { trending });
    } catch (error: any) {
      console.error('Get trending hashtags error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch trending hashtags');
    }
  }

  /**
   * GET /api/public/topics/:tag/posts
   * Visible posts for one hashtag (TopicsPage tag detail), newest first —
   * the same visibility filter as getTrending (active status, ready media)
   * and the same per-post DTO as listByAuthor/listByEvent
   * (UpdateController.dto), so the client renders these with its existing
   * post-grid components rather than a new shape. Uses the
   * { hashtags: 1, createdAt: -1 } multikey index on Update. Page-based
   * pagination (page/limit) per the spec for this endpoint, not the cursor
   * convention used by the author/event post lists.
   */
  static async getTopicPosts(req: Request, res: Response): Promise<any> {
    try {
      const tag = normalizeHashtag(req.params['tag']);
      if (!tag) {
        return ApiResponseUtil.validationError(res, 'Invalid tag');
      }

      const { error, value } = topicPostsQuerySchema.validate(req.query);
      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }
      const { page, limit } = value;

      const filter = { hashtags: tag, status: 'active', 'media.status': 'ready' };
      const skip = (page - 1) * limit;
      // Over-fetch by one to detect a further page without a second count query.
      const docs = await Update.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit + 1);
      const hasMore = docs.length > limit;
      const pageDocs = docs.slice(0, limit);

      const actor = await resolveActorFromRequest(req).catch(() => null);
      const reactions = actor && pageDocs.length
        ? await getViewerReactions(pageDocs.map((d) => d.id), actor)
        : undefined;
      const posts = pageDocs.map((d) =>
        UpdateController.dto(d, reactions?.[d.id], UpdateController.isActorAuthor(d, actor)),
      );

      return ApiResponseUtil.success(res, { posts, tag, page, hasMore });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to fetch group chat posts');
    }
  }

  /**
   * Get single published event by ID (no auth required)
   */
  static async getPublicEvent(req: Request, res: Response): Promise<any> {
    try {
      const { eventId } = req.params;

      // Validate eventId format
      if (!eventId || !eventId.match(/^[0-9a-fA-F]{24}$/)) {
        return ApiResponseUtil.error(res, 'Invalid event ID format', 400);
      }

      const event = await Event.findOne({
        _id: eventId,
        status: EventStatus.PUBLISHED
      }).lean();

      if (!event) {
        return ApiResponseUtil.notFound(res, 'Event not found or not available');
      }

      const organizer = await PublicController.resolveOrganizer(event.vendorId);

      // Transform for public display
      const publicEvent = {
        ...toPublicEventCard(event, { organizer }),
        isMultiDay: event.isMultiDay,
        galleryImages: event.galleryImages,
        // Per-account ticket cap ("one ticket per person"). Exposed only on the
        // detail payload (not list cards) so the buyer UI can show the limit and
        // cap the quantity selector. Absent/unset = unlimited. Enforcement is
        // still server-authoritative in checkTicketAvailability — this is purely
        // to inform the buyer up front.
        maxTicketsPerAccount: event.maxTicketsPerAccount,
      };

      return ApiResponseUtil.success(res, publicEvent);
    } catch (error: any) {
      console.error('Get public event error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch event');
    }
  }

  /**
   * Purchase tickets (public - no auth required, uses Keshless card payment)
   */
  static async purchaseTickets(req: Request, res: Response): Promise<any> {
    try {
      // Validate input
      const { error, value } = publicPurchaseSchema.validate(req.body);
      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const {
        eventId,
        items,
        keshlessCardNumber,
        keshlessPin
      } = value;

      // The buyer is authenticated (authenticateBuyer middleware). Identity is
      // resolved buyerId-primary (falling back to phone) — never a
      // client-supplied value — so the ticket is bound to the account they
      // proved they own and always appears under their "My Tickets". Mirrors
      // initiateMomoPurchase/card/DeltaPay so an email-only buyer (no
      // userPhone on the token) isn't wrongly rejected here.
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
      }

      // Single source of truth for the buyer purchase flow (shared with the
      // in-app proxy checkout) so process + amount charged are identical.
      const result = await TicketService.purchaseForCustomer({
        eventId,
        items,
        customerPhone: buyer.phone,
        customerEmail: buyer.email,
        buyerId: String(buyer._id),
        customerName: value.customerName as string | undefined,
        keshlessCardNumber,
        keshlessPin,
      });

      return ApiResponseUtil.created(res, result, 'Tickets purchased successfully!');
    } catch (error: any) {
      console.error('Purchase tickets error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to purchase tickets');
    }
  }

  /**
   * Claim a FREE ticket — the checkout path for a tier priced at 0. No payment
   * method is involved (the client never even shows one), so there's nothing to
   * charge. The service re-verifies the tier is actually free against the DB,
   * so this endpoint can never be used to obtain a paid ticket for free.
   */
  static async claimFreeTicket(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = freeClaimSchema.validate(req.body);
      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      // Identity comes from the OTP-verified buyer token (buyerId-primary,
      // phone fallback) — never the body — so the free ticket is bound to the
      // account they proved they own and surfaces under their "My Tickets".
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to get a ticket');
      }

      const result = await TicketService.claimFreeTicket({
        eventId: value.eventId,
        items: value.items,
        customerPhone: buyer.phone,
        customerEmail: buyer.email,
        buyerId: String(buyer._id),
        customerName: value.customerName as string | undefined,
      });

      return ApiResponseUtil.created(res, result, 'Your free ticket is confirmed!');
    } catch (error: any) {
      console.error('Claim free ticket error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to get your ticket');
    }
  }

  /**
   * Buyer sign-in — email or phone + password for EXISTING accounts.
   *
   * If the identifier has no account yet, registration is OTP-gated: we
   * return `{ requiresRegistration: true }` (HTTP 200) so the client routes
   * the buyer to requestBuyerRegistrationOtp -> registerBuyer rather than
   * silently creating an account for an unproven email or phone.
   */
  static async loginBuyer(req: Request, res: Response): Promise<any> {
    try {
      const { identifier, password } = req.body;
      if (!identifier || !password) {
        return ApiResponseUtil.error(res, 'Email or phone and password are required', 400);
      }

      const result = await BuyerAuthService.login(identifier, password);
      if (result.requiresRegistration) {
        return ApiResponseUtil.success(
          res,
          result,
          'Verify your email or phone to create your account'
        );
      }
      return ApiResponseUtil.success(res, result, 'Signed in successfully');
    } catch (error: any) {
      console.error('Buyer login error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to sign in', 401);
    }
  }

  /**
   * Registration step 1: send a verification code to a NEW email or phone.
   * Rejects identifiers that already have an account.
   */
  static async requestBuyerRegistrationOtp(req: Request, res: Response): Promise<any> {
    try {
      const { identifier } = req.body;
      if (!identifier || typeof identifier !== 'string') {
        return ApiResponseUtil.error(res, 'Email or phone is required', 400);
      }

      const result = await BuyerAuthService.requestRegistrationOtp(identifier);
      return ApiResponseUtil.success(res, result, 'We sent a code to your email or phone');
    } catch (error: any) {
      console.error('Request buyer registration OTP error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to send verification code', 400);
    }
  }

  /**
   * Registration step 2: verify the code, create the account with the chosen
   * password, and issue an access token.
   */
  static async registerBuyer(req: Request, res: Response): Promise<any> {
    try {
      const { identifier, code, password, name } = req.body;
      if (!identifier || !code || !password) {
        return ApiResponseUtil.error(res, 'Email or phone, code and password are required', 400);
      }

      const result = await BuyerAuthService.registerWithOtp(identifier, code, password, name);
      return ApiResponseUtil.success(res, result, 'Account created — you are signed in');
    } catch (error: any) {
      console.error('Register buyer error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to create account', 401);
    }
  }

  /**
   * Password reset step 1: send a code to an email or phone that HAS an
   * account. Rejects identifiers with no account (they must sign up).
   */
  static async forgotPasswordBuyer(req: Request, res: Response): Promise<any> {
    try {
      const { identifier } = req.body;
      if (!identifier || typeof identifier !== 'string') {
        return ApiResponseUtil.error(res, 'Email or phone is required', 400);
      }

      const result = await BuyerAuthService.requestPasswordResetOtp(identifier);
      return ApiResponseUtil.success(res, result, 'We sent a reset code to your email or phone');
    } catch (error: any) {
      console.error('Forgot password buyer error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to send reset code', 400);
    }
  }

  /**
   * Password reset step 2: verify the code, set the new password, and issue an
   * access token so the buyer is signed straight in.
   */
  static async resetPasswordBuyer(req: Request, res: Response): Promise<any> {
    try {
      const { identifier, code, password } = req.body;
      if (!identifier || !code || !password) {
        return ApiResponseUtil.error(res, 'Email or phone, code and new password are required', 400);
      }

      const result = await BuyerAuthService.resetPassword(identifier, code, password);
      return ApiResponseUtil.success(res, result, 'Password reset — you are signed in');
    } catch (error: any) {
      console.error('Reset password buyer error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to reset password', 401);
    }
  }

  /**
   * Returns the payment methods available to the buyer checkout.
   * A method is included iff its config toggle is ON and (for MoMo) the
   * MTN_MOMO_ENABLED env var is 'true' (processor-configured guard for Task 6).
   * Cash is excluded — not a buyer-online method.
   */
  static async getPaymentMethods(req: Request, res: Response): Promise<any> {
    try {
      const cfg = await PaymentConfigService.get();
      // Optional event scope. An event whose organizer covers the booking fee
      // charges the buyer face, so checkout must not display a fee it will
      // never collect — the amount shown has to equal the amount charged.
      // An unknown/malformed id falls through to the configured fees rather
      // than silently zeroing them: showing E0 and then charging E5 is the
      // one outcome worse than showing the fee.
      const eventId = typeof req.query['eventId'] === 'string' ? req.query['eventId'] : undefined;
      const absorbed = !!eventId
        && mongoose.Types.ObjectId.isValid(eventId)
        && !!(await Event.findById(eventId).select('organizerAbsorbsServiceFee').lean())?.organizerAbsorbsServiceFee;
      const methods: string[] = [];
      if (cfg.keshlessWalletEnabled) methods.push('keshless_wallet');
      if (cfg.mtnMomoEnabled && process.env['MTN_MOMO_ENABLED'] === 'true') methods.push('mtn_momo');
      if (cfg.peachCardEnabled && new PeachClient().isConfigured()) methods.push('peach_card');
      // DeltaPay needs BOTH the config toggle and live credentials — a
      // half-configured deploy hides the button instead of failing at checkout.
      if (cfg.deltapayEnabled && new DeltapayClient().isConfigured()) methods.push('deltapay');
      // Yoco, same rule: toggle AND live credentials, else the button is hidden.
      if (cfg.yocoEnabled && new YocoClient().isConfigured()) methods.push('yoco');
      // YeboPay, same rule again: toggle AND live credentials, else hidden.
      if (cfg.yebopayEnabled && new YeboPayClient().isConfigured()) methods.push('yebopay');
      // Per-method flat buyer service fee (E) so checkout can show a live
      // breakdown. The charge is recomputed server-side on purchase (display only).
      const serviceFees = absorbed
        ? { keshless_wallet: 0, mtn_momo: 0, peach_card: 0, deltapay: 0, yoco: 0, yebopay: 0 }
        : {
            keshless_wallet: cfg.keshlessServiceFee,
            mtn_momo: cfg.momoServiceFee,
            peach_card: cfg.cardServiceFee,
            deltapay: cfg.deltapayServiceFee,
            yoco: cfg.yocoServiceFee,
            yebopay: cfg.yebopayServiceFee,
          };
      return ApiResponseUtil.success(res, { methods, serviceFees });
    } catch (error: any) {
      console.error('Get public payment methods error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch payment methods');
    }
  }

  /**
   * Initiate an async MTN MoMo purchase.
   * Identity comes from the resolved buyer (buyerId-primary, phone fallback),
   * NEVER the body. momoPhone (the MoMo wallet number) IS from body.
   */
  static async initiateMomoPurchase(req: Request, res: Response): Promise<any> {
    const { error, value } = momoInitiateSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
    try {
      const r = await TicketService.initiateMomoPurchase({
        ...value,
        customerPhone: buyer.phone,
        customerEmail: buyer.email,
        buyerId: String(buyer._id),
        channel: SalesChannel.ONLINE,
      });
      return ApiResponseUtil.success(res, r);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Could not start MoMo payment', 400);
    }
  }

  /**
   * Poll MTN MoMo payment status and trigger finalization on SUCCESSFUL.
   * Ownership check: buyerId-primary (the sale's stamped buyerId must match
   * the authenticated buyer's _id), with a legacy phone fallback for sales
   * that predate buyerId stamping. A mismatched or missing sale returns 404
   * to avoid leaking existence info.
   */
  static async getMomoStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      }

      const referenceId = req.params['referenceId']!;
      const sale = await TicketService.getMomoSaleByReference(referenceId);

      const owns =
        sale &&
        ((sale.buyerId && String(sale.buyerId) === String(buyer._id)) ||
          (!sale.buyerId &&
            sale.customerPhone &&
            buyer.phone &&
            normalizePhone(sale.customerPhone) === normalizePhone(buyer.phone)));
      if (!owns) {
        return ApiResponseUtil.notFound(res, 'Payment not found');
      }

      const result = await TicketService.finalizeMomoSale(referenceId);
      return ApiResponseUtil.success(res, result);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Status check failed', 400);
    }
  }

  /**
   * Initiate an async Peach card payment.
   * Identity comes from the resolved buyer (buyerId-primary, phone fallback),
   * NEVER the body.
   */
  static async initiateCardPurchase(req: Request, res: Response): Promise<any> {
    const { error, value } = cardInitiateSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
    try {
      const r = await TicketService.initiateCardPurchase({
        ...value,
        customerPhone: buyer.phone,
        customerEmail: buyer.email,
        buyerId: String(buyer._id),
        channel: SalesChannel.ONLINE,
      });
      return ApiResponseUtil.success(res, r);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Could not start card payment', 400);
    }
  }

  /**
   * Poll Peach card payment status and trigger finalization.
   * Ownership check: buyerId-primary (the sale's stamped buyerId must match
   * the authenticated buyer's _id), with a legacy phone fallback for sales
   * that predate buyerId stamping. A mismatched or missing sale returns 404
   * to avoid leaking existence info.
   */
  static async getCardStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      }

      const paymentId = req.params['paymentId']!;
      const sale = await TicketService.getCardSaleByPaymentId(paymentId);

      const owns =
        sale &&
        ((sale.buyerId && String(sale.buyerId) === String(buyer._id)) ||
          (!sale.buyerId &&
            sale.customerPhone &&
            buyer.phone &&
            normalizePhone(sale.customerPhone) === normalizePhone(buyer.phone)));
      if (!owns) {
        return ApiResponseUtil.notFound(res, 'Payment not found');
      }

      const result = await TicketService.finalizeCardSale(paymentId);
      return ApiResponseUtil.success(res, result);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Status check failed', 400);
    }
  }

  /**
   * Initiate an async Yoco hosted-checkout purchase. Buyer-authed.
   * Returns the redirect URL for the SPA to send the buyer to.
   */
  static async initiateYocoPurchase(req: Request, res: Response): Promise<any> {
    const { error, value } = yocoInitiateSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
    try {
      const r = await TicketService.initiateYocoPurchase({
        ...value,
        customerPhone: buyer.phone,
        customerEmail: buyer.email,
        buyerId: String(buyer._id),
        channel: SalesChannel.ONLINE,
      });
      return ApiResponseUtil.success(res, r);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Could not start Yoco payment', 400);
    }
  }

  /**
   * Initiate an async YeboPay hosted-checkout purchase. Buyer-authed.
   * Returns the redirect URL for the SPA to send the buyer to.
   */
  static async initiateYeboPayPurchase(req: Request, res: Response): Promise<any> {
    const { error, value } = yebopayInitiateSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
    try {
      const r = await TicketService.initiateYeboPayPurchase({
        ...value,
        customerPhone: buyer.phone,
        customerEmail: buyer.email,
        buyerId: String(buyer._id),
        channel: SalesChannel.ONLINE,
      });
      return ApiResponseUtil.success(res, r);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Could not start YeboPay payment', 400);
    }
  }

  /**
   * Poll the outcome of a Yoco purchase. Buyer-authed.
   *
   * READ-ONLY, unlike getCardStatus and getDeltapayStatus. Those poll the
   * provider and finalise as a side effect; Yoco exposes no status-query
   * endpoint, so the only thing that can move this sale is the signed webhook.
   * This endpoint simply reports the sale's current stored status.
   *
   * Ownership check mirrors getDeltapayStatus: buyerId-primary with a legacy
   * phone fallback, and a mismatch returns 404 (not 403) so the endpoint cannot
   * be used to enumerate other buyers' checkouts.
   */
  static async getYocoStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      }

      const checkoutId = req.params['checkoutId']!;
      const sale = await TicketService.getYocoSaleByCheckoutId(checkoutId);

      const owns =
        sale &&
        ((sale.buyerId && String(sale.buyerId) === String(buyer._id)) ||
          (!sale.buyerId &&
            sale.customerPhone &&
            buyer.phone &&
            normalizePhone(sale.customerPhone) === normalizePhone(buyer.phone)));
      if (!owns) {
        return ApiResponseUtil.notFound(res, 'Payment not found');
      }

      const status =
        sale.paymentStatus === 'completed'
          ? 'completed'
          : sale.paymentStatus === 'pending'
          ? 'pending'
          : 'failed';
      return ApiResponseUtil.success(res, { status });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Status check failed', 400);
    }
  }

  /**
   * Outcome of the signed-in buyer's MOST RECENT Yoco payment. Buyer-authed.
   *
   * This is what replaced the identifiers the return URL used to carry. That URL
   * is unauthenticated and its `ref` is not secret, so echoing a checkout id or
   * status there let anyone probe whether a sale existed and was paid. Asking
   * here instead means the answer is scoped to the caller's own purchases.
   *
   * READ-ONLY, like getYocoStatus: Yoco has no status-query endpoint, so the
   * server can only report what the signed webhook already recorded. Returns
   * `{ status: 'none' }` when the buyer has no Yoco purchase at all, so the page
   * can tell "nothing to show" apart from "failed".
   */
  static async getLatestYocoStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      }

      const sale = await TicketService.getLatestYocoSaleForBuyer(buyer);
      if (!sale?.yocoCheckoutId) {
        return ApiResponseUtil.success(res, { status: 'none' });
      }

      const status =
        sale.paymentStatus === 'completed'
          ? 'completed'
          : sale.paymentStatus === 'pending'
          ? 'pending'
          : 'failed';
      return ApiResponseUtil.success(res, { status, checkoutId: sale.yocoCheckoutId });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Status check failed', 400);
    }
  }

  /**
   * Outcome of ONE YeboPay payment, by reference, scoped to the caller.
   *
   * The exact answer the result page wants. A ref the caller does not own is
   * reported as 'none' — identical to a ref that does not exist — so an
   * authenticated buyer cannot probe other people's sales.
   */
  static async getYeboPayStatusByRef(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      }

      const ref = String(req.params['ref'] || '');
      if (!ref) return ApiResponseUtil.success(res, { status: 'none' });

      const sale = await TicketService.getYeboPaySaleByRefForBuyer(ref, buyer);
      if (!sale?.yebopayCheckoutId) {
        return ApiResponseUtil.success(res, { status: 'none' });
      }

      const status =
        sale.paymentStatus === 'completed'
          ? 'completed'
          : sale.paymentStatus === 'pending'
          ? 'pending'
          : 'failed';
      return ApiResponseUtil.success(res, { status, checkoutId: sale.yebopayCheckoutId });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Status check failed', 400);
    }
  }

  /**
   * Outcome of the buyer's most recent YeboPay payment.
   *
   * Mirrors getLatestYocoStatus: the YeboPay return redirect deliberately
   * carries no identifiers, so this authenticated endpoint — scoped to the
   * caller's own sales — is how the result page learns the outcome.
   */
  static async getLatestYeboPayStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      }

      const sale = await TicketService.getLatestYeboPaySaleForBuyer(buyer);
      if (!sale?.yebopayCheckoutId) {
        return ApiResponseUtil.success(res, { status: 'none' });
      }

      const status =
        sale.paymentStatus === 'completed'
          ? 'completed'
          : sale.paymentStatus === 'pending'
          ? 'pending'
          : 'failed';
      return ApiResponseUtil.success(res, { status, checkoutId: sale.yebopayCheckoutId });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Status check failed', 400);
    }
  }

  /**
   * Initiate an async DeltaPay hosted-checkout purchase. Buyer-authed.
   * Returns the checkout URL for the SPA to redirect to.
   */
  static async initiateDeltapayPurchase(req: Request, res: Response): Promise<any> {
    const { error, value } = deltapayInitiateSchema.validate(req.body);
    if (error) return ApiResponseUtil.badRequest(res, error.message);
    const buyer = await resolveBuyerFromRequest(req);
    if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in to buy a ticket');
    try {
      const r = await TicketService.initiateDeltapayPurchase({
        ...value,
        customerPhone: buyer.phone,
        customerEmail: buyer.email,
        buyerId: String(buyer._id),
        channel: SalesChannel.ONLINE,
      });
      return ApiResponseUtil.success(res, r);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Could not start DeltaPay payment', 400);
    }
  }

  /**
   * Poll the outcome of a DeltaPay purchase. Buyer-authed.
   *
   * Mirrors getCardStatus, including the ownership check: buyerId-primary
   * (the sale's stamped buyerId must match the authenticated buyer's _id),
   * with a legacy phone fallback for sales that predate buyerId stamping.
   * A mismatch returns 404 (not 403) so this endpoint can't be used to
   * enumerate other buyers' checkout sessions.
   */
  static async getDeltapayStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      }

      const sessionId = req.params['sessionId']!;
      const sale = await TicketService.getDeltapaySaleBySessionId(sessionId);

      const owns =
        sale &&
        ((sale.buyerId && String(sale.buyerId) === String(buyer._id)) ||
          (!sale.buyerId &&
            sale.customerPhone &&
            buyer.phone &&
            normalizePhone(sale.customerPhone) === normalizePhone(buyer.phone)));
      if (!owns) {
        return ApiResponseUtil.notFound(res, 'Payment not found');
      }

      const result = await TicketService.finalizeDeltapaySale(sessionId);
      return ApiResponseUtil.success(res, result);
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Status check failed', 400);
    }
  }

  /**
   * Outcome of the signed-in buyer's MOST RECENT DeltaPay payment. Buyer-authed.
   *
   * This exists because nothing on the DeltaPay return redirect can be relied on
   * to identify the payment: DeltaPay echoes no identifiers back, and query
   * parameters added to return_url are not guaranteed to survive. Rather than
   * parse the URL, the result page asks this endpoint — the buyer is already
   * authenticated, so their own latest purchase is the unambiguous answer.
   *
   * Like the by-session endpoint, it finalises as a side effect: the sale is put
   * through verify-return, which is what actually mints tickets. Returns
   * `{ status: 'none' }` when the buyer has no DeltaPay purchase at all, so the
   * page can distinguish "nothing to show" from "failed".
   *
   * Resolves the buyer buyerId-primary (userPhone fallback) so an email-only
   * buyer's latest DeltaPay sale is found even without a phone.
   */
  static async getLatestDeltapayStatus(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to check payment status');
      }

      const sale = await TicketService.getLatestDeltapaySaleForBuyer(buyer);
      if (!sale?.deltapaySessionId) {
        return ApiResponseUtil.success(res, { status: 'none' });
      }

      const result = await TicketService.finalizeDeltapaySale(sale.deltapaySessionId);
      return ApiResponseUtil.success(res, { ...result, sessionId: sale.deltapaySessionId });
    } catch (e: any) {
      return ApiResponseUtil.error(res, e.message || 'Status check failed', 400);
    }
  }

  /**
   * List the signed-in buyer's tickets. Resolves the buyer (buyerId-primary,
   * userPhone fallback — see resolveBuyerFromRequest) and matches tickets by
   * whichever handle(s) that buyer has, so an email-only buyer's tickets are
   * found even without a phone.
   */
  static async getMyTickets(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to view your tickets');
      }

      const tickets = await TicketService.findTicketsForBuyer({
        _id: buyer._id,
        phone: buyer.phone,
        email: buyer.email,
      });
      return ApiResponseUtil.success(res, tickets);
    } catch (error: any) {
      console.error('Get buyer tickets error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to fetch tickets');
    }
  }

  /**
   * Receive a message from the public "Contact Support" form. The message is
   * stored durably (ContactMessage) — that write is the operation's success
   * condition, so a failure returns 500 rather than pretending it worked. A
   * best-effort SMS alert to the support line is then fired-and-forgotten so a
   * human is nudged; its outcome never affects the response the buyer sees.
   */
  static async submitContactMessage(req: Request, res: Response): Promise<any> {
    try {
      const { error, value } = contactMessageSchema.validate(req.body);
      if (error) {
        return ApiResponseUtil.validationError(res, error.details[0]?.message || 'Validation error');
      }

      await ContactMessage.create({
        name: value.name,
        email: value.email,
        subject: value.subject,
        message: value.message,
      });

      // The message is now durably stored; support reads and replies from the
      // admin dashboard. No outbound notification is sent.
      return ApiResponseUtil.success(
        res,
        { received: true },
        "Thanks for reaching out — we've received your message and will get back to you soon.",
        201,
      );
    } catch (error: any) {
      console.error('Submit contact message error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to send your message');
    }
  }
}
