import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { EventStatus, IEvent, ITicketType } from '@interfaces/event.interface';
import { PaymentMethod, TicketStatus } from '@interfaces/ticket.interface';
import { Ticket } from '@models/ticket.model';
import { normalizePhone } from '@utils/phone.util';
import type { EventCategory } from '@/constants/eventCategories';
import mongoose from 'mongoose';
import { CommunityService } from '@services/community.service';
import { HttpError } from '@utils/httpError.util';
import { LedgerEntry } from '@models/ledgerEntry.model';

export interface CreateEventParams {
  vendorId?: string;
  submittedByBuyerId?: string;
  status?: EventStatus;
  name: string;
  description?: string;
  venue: string;
  eventDate: Date;
  startTime: Date;
  endTime: Date;
  isMultiDay?: boolean;
  cashless?: boolean; // NFC tap-and-go wallet/POS toggle (cashless spec §11); defaults to false via the model
  isSuperAdmin?: boolean; // only an admin may create an event already marked cashless
  capacity?: number; // optional — derived from ticket-type quantities server-side
  ticketTypes?: Array<{
    name: string;
    description?: string;
    price: number;
    quantity: number;
  }>;
  category?: EventCategory;
  ticketing?: 'carrot' | 'external';
  externalTicketUrl?: string;
  currency?: 'SZL' | 'ZAR';
  priceMin?: number;
  priceMax?: number;
  lineup?: string[];
  outfitThemeOptions?: string[];
}

export interface UpdateEventParams {
  name?: string;
  description?: string;
  venue?: string;
  eventDate?: Date;
  startTime?: Date;
  endTime?: Date;
  isMultiDay?: boolean;
  cashless?: boolean; // NFC tap-and-go wallet/POS toggle (cashless spec §11)
  capacity?: number;
  ticketTypes?: Array<{
    // The tier being edited, echoed back from the event. Absent = a brand-new
    // tier, or an older caller that only knows names. Sending it is what lets a
    // tier be RENAMED without reading as delete-then-recreate (which would
    // reset its sold count); see updateEvent.
    _id?: string;
    name: string;
    description?: string;
    price: number;
    quantity: number;
    isSoldOut?: boolean;
  }>;
  category?: EventCategory;
  ticketing?: 'carrot' | 'external';
  externalTicketUrl?: string;
  currency?: 'SZL' | 'ZAR';
  priceMin?: number;
  priceMax?: number;
  lineup?: string[];
  outfitThemeOptions?: string[];
}

export interface GetEventsQuery {
  vendorId: string;
  status?: EventStatus;
  startDate?: Date;
  endDate?: Date;
  search?: string;
  page?: number;
  limit?: number;
  isSuperAdmin?: boolean;
  /**
   * When set, ONLY these events are listed — the caller's back-office event
   * assignment. Undefined means unrestricted; an EMPTY array means restricted
   * to nothing and must list nothing, so this is deliberately checked for
   * presence rather than length. Guarding on `.length` would turn the
   * deny-everything case into show-everything.
   */
  allowedEventIds?: string[];
  /**
   * Narrows a super-admin's platform-wide view to one organizer. Ignored for
   * everyone else — their own vendorId already scopes the query, so this can
   * never widen access.
   */
  filterVendorId?: string;
}

export function computeAvailable(t: { quantity: number; sold: number; reserved?: number }): number {
  return Math.max(0, t.quantity - t.sold - (t.reserved || 0));
}

export class EventService {
  /**
   * Create a new event
   */
  static async createEvent(params: CreateEventParams): Promise<IEvent> {
    try {
      // Cashless is an admin switch (see updateEvent) — an organizer creating
      // an event cannot hand themselves bands, a float and a settlement run.
      if (params.cashless === true && !params.isSuperAdmin) {
        throw new HttpError(403, 'Only an administrator can enable cashless for an event');
      }
      // Create event
      const event = new Event({
        vendorId: params.vendorId,
        submittedByBuyerId: params.submittedByBuyerId,
        name: params.name,
        description: params.description,
        venue: params.venue,
        eventDate: params.eventDate,
        startTime: params.startTime,
        endTime: params.endTime,
        isMultiDay: params.isMultiDay,
        cashless: params.cashless,
        capacity: params.capacity,
        category: params.category ?? 'Other',
        ticketing: params.ticketing ?? 'carrot',
        externalTicketUrl: params.externalTicketUrl,
        currency: params.currency ?? 'SZL',
        priceMin: params.priceMin,
        priceMax: params.priceMax,
        lineup: params.lineup,
        outfitThemeOptions: params.outfitThemeOptions,
        ticketTypes: params.ticketTypes ? params.ticketTypes.map(tt => ({
          name: tt.name,
          description: tt.description,
          price: tt.price,
          quantity: tt.quantity,
          sold: 0,
          reserved: 0,
          available: tt.quantity,
          isSoldOut: false
        })) : [],
        status: params.status ?? EventStatus.DRAFT,
        totalTicketsSold: 0,
        totalRevenue: 0
      });

      await event.save();
      return event;
    } catch (error: any) {
      if (error instanceof HttpError) throw error;
      console.error('Event creation error:', error);
      throw new Error(error.message || 'Failed to create event');
    }
  }

  /**
   * Get events with filters and pagination
   */
  static async getEvents(query: GetEventsQuery) {
    try {
      const {
        vendorId,
        status,
        startDate,
        endDate,
        search,
        page = 1,
        limit = 20,
        isSuperAdmin = false,
        allowedEventIds,
        filterVendorId
      } = query;

      // Build query - skip vendorId filter for superadmin
      const filter: any = {};
      if (!isSuperAdmin) {
        // The listing runs through aggregate() below, which bypasses Mongoose's
        // schema-aware casting — a raw string here matches zero documents
        // instead of erroring, so cast to ObjectId explicitly.
        filter.vendorId = new mongoose.Types.ObjectId(vendorId);
      } else if (filterVendorId) {
        // Same cast, same reason. Only reachable for a super-admin — the
        // controller routes a client-supplied vendorId here, never into
        // `vendorId`, so it can only ever narrow a platform-wide view.
        filter.vendorId = new mongoose.Types.ObjectId(filterVendorId);
      }

      // An event assignment narrows the list for anyone who carries one,
      // including a caller listed as super-admin (resellers list this way), so
      // it is applied OUTSIDE the branch above. Same ObjectId cast, same
      // reason: aggregate() does no schema-aware casting of its own.
      if (allowedEventIds) {
        filter._id = { $in: allowedEventIds.map((id) => new mongoose.Types.ObjectId(id)) };
      }

      if (status) {
        filter.status = status;
      }

      if (startDate || endDate) {
        filter.eventDate = {};
        if (startDate) filter.eventDate.$gte = startDate;
        if (endDate) filter.eventDate.$lte = endDate;
      }

      if (search) {
        filter.$or = [
          { name: { $regex: search, $options: 'i' } },
          { venue: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ];
      }

      // Execute query with pagination.
      //
      // Ordering is relevance-first, not newest-first. The sort runs BEFORE the
      // limit, so it decides which events are in the response at all, not just
      // how they're arranged — under the old `eventDate: -1` a gate operator
      // whose organizer had 20+ future events never saw today's event in the
      // POS scanner list, because it sat below every future one on page 2.
      //
      // Two buckets, both keyed off event date:
      //   0 - live or still to come (anything whose end hasn't passed), soonest
      //       first, which puts today's event - and any multi-day event still
      //       running - at the top
      //   1 - finished, most recent first
      const startOfToday = new Date();
      startOfToday.setUTCHours(0, 0, 0, 0);

      const skip = (page - 1) * limit;
      const [events, total] = await Promise.all([
        Event.aggregate([
          { $match: filter },
          {
            $addFields: {
              _finished: {
                $cond: [
                  { $gte: [{ $ifNull: ['$endTime', '$eventDate'] }, startOfToday] },
                  0,
                  1
                ]
              }
            }
          },
          {
            $addFields: {
              // Finished events read best newest-first; negating their key flips
              // that bucket's direction inside a single ascending sort.
              _order: {
                $cond: [
                  { $eq: ['$_finished', 1] },
                  { $multiply: [{ $toLong: '$eventDate' }, -1] },
                  { $toLong: '$eventDate' }
                ]
              }
            }
          },
          { $sort: { _finished: 1, _order: 1, createdAt: -1 } },
          { $skip: skip },
          { $limit: limit },
          { $project: { _finished: 0, _order: 0 } }
        ]),
        Event.countDocuments(filter)
      ]);

      return {
        data: events,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrev: page > 1
        }
      };
    } catch (error: any) {
      console.error('Get events error:', error);
      throw new Error(error.message || 'Failed to fetch events');
    }
  }

  /**
   * Get single event by ID
   */
  static async getEventById(eventId: string, vendorId: string, isSuperAdmin: boolean = false): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }

      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      return event;
    } catch (error: any) {
      console.error('Get event by ID error:', error);
      throw new Error(error.message || 'Failed to fetch event');
    }
  }

  /**
   * Get the creator (vendor) of an event plus a summary of all their events.
   *
   * Powers the admin "Creator" panel: who made this event, their contact and
   * verification status, and a roll-up of every event they own with ticket /
   * revenue totals. `requesterVendorId` / `isSuperAdmin` enforce access — a
   * normal organiser may only view their own creator card, superadmins any.
   */
  static async getEventCreatorSummary(
    eventId: string,
    requesterVendorId: string,
    isSuperAdmin: boolean = false
  ) {
    const event = await Event.findById(eventId).select('vendorId').lean();
    if (!event) {
      throw new Error('Event not found');
    }

    const creatorId = event.vendorId!.toString();
    if (!isSuperAdmin && creatorId !== requesterVendorId) {
      throw new Error('You do not have access to this creator');
    }

    const vendor = await Vendor.findById(creatorId)
      .select('businessName email phoneNumber primaryContact businessType verificationStatus verifiedAt isActive createdAt')
      .lean();
    if (!vendor) {
      throw new Error('Creator not found');
    }

    const events = await Event.find({ vendorId: creatorId })
      .select('name status eventDate venue totalTicketsSold totalRevenue capacity posterUrl thumbnailUrl currency createdAt')
      .sort({ eventDate: -1, createdAt: -1 })
      .lean();

    const stats = events.reduce(
      (acc, e) => {
        acc.totalEvents += 1;
        acc.totalTicketsSold += e.totalTicketsSold || 0;
        acc.totalRevenue += e.totalRevenue || 0;
        return acc;
      },
      { totalEvents: 0, totalTicketsSold: 0, totalRevenue: 0 }
    );

    const eventsWithCurrency = events.map((e) => ({ ...e, currency: e.currency ?? 'SZL' }));

    return { creator: vendor, stats, events: eventsWithCurrency };
  }

  /**
   * Update event
   */
  static async updateEvent(
    eventId: string,
    vendorId: string,
    updates: UpdateEventParams,
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      // Don't allow updates if event is cancelled
      if (event.status === EventStatus.CANCELLED) {
        throw new Error('Cannot update cancelled event');
      }

      // Don't allow updates if event is completed
      if (event.status === EventStatus.COMPLETED) {
        throw new Error('Cannot update completed event');
      }

      // Core "Event Information" (name, venue, date/time, description, category,
      // capacity) is owner-editable ONLY before the event goes live. A DRAFT or
      // PENDING_APPROVAL event has no sold tickets, so the organizer may freely
      // fix these while getting the listing right. Once PUBLISHED/ONGOING,
      // silently changing them is a bait-and-switch on people who already hold
      // tickets — only an administrator may correct a live event. Enforced here,
      // not just hidden in the dashboard UI. (CANCELLED/COMPLETED are already
      // blocked above for everyone.) Ticketing/pricing settings are deliberately
      // NOT core info — organizers legitimately tune those on a live event.
      const isPrePublish =
        event.status === EventStatus.DRAFT || event.status === EventStatus.PENDING_APPROVAL;
      if (!isSuperAdmin && !isPrePublish) {
        const sameInstant = (a: any, b: any) => new Date(a).getTime() === new Date(b).getTime();
        const changesCoreInfo =
          (updates.name !== undefined && updates.name !== event.name) ||
          (updates.description !== undefined && updates.description !== event.description) ||
          (updates.venue !== undefined && updates.venue !== event.venue) ||
          (updates.eventDate !== undefined && !sameInstant(updates.eventDate, event.eventDate)) ||
          (updates.startTime !== undefined && !sameInstant(updates.startTime, event.startTime)) ||
          (updates.endTime !== undefined && !sameInstant(updates.endTime, event.endTime)) ||
          (updates.isMultiDay !== undefined && updates.isMultiDay !== event.isMultiDay) ||
          (updates.category !== undefined && updates.category !== event.category) ||
          (updates.capacity !== undefined && updates.capacity !== event.capacity);
        if (changesCoreInfo) {
          throw new HttpError(403, 'Only an administrator can change event details once it is published');
        }
      }

      // `cashless` is not an ordinary setting. Turning it ON commits Carrot to
      // bands, handhelds, a float and a settlement run, so only an admin may do
      // it — and unlike the core-info lock above, that holds at EVERY status,
      // draft included. Turning it OFF is barred for everyone once money has
      // moved: wallets, merchants and stock outlive the flag, so unsetting it
      // would strand funded bands behind "Event is not cashless" while the
      // ledger still owes them. Compared against the stored value so an edit
      // form echoing back the current value is not read as a switch.
      if (updates.cashless !== undefined && updates.cashless !== event.cashless) {
        if (!isSuperAdmin) {
          throw new HttpError(403, "Only an administrator can change an event's cashless setting");
        }
        if (updates.cashless === false && (await LedgerEntry.exists({ eventId: event._id }))) {
          throw new HttpError(
            409,
            'Cashless cannot be switched off — money has already moved on this event',
          );
        }
      }

      // Update fields
      if (updates.name) event.name = updates.name;
      if (updates.description !== undefined) event.description = updates.description;
      if (updates.venue) event.venue = updates.venue;
      if (updates.eventDate) event.eventDate = updates.eventDate;
      if (updates.startTime) event.startTime = updates.startTime;
      if (updates.endTime) event.endTime = updates.endTime;
      if (updates.isMultiDay !== undefined) event.isMultiDay = updates.isMultiDay;
      if (updates.capacity) event.capacity = updates.capacity;
      // Boolean toggle — !== undefined so `cashless: false` actually unsets
      // it (a truthy check would silently ignore false, same trap as
      // isMultiDay not being threaded here at all).
      if (updates.cashless !== undefined) {
        event.cashless = updates.cashless;
        // Granted — the standing request has been answered.
        if (updates.cashless === true) {
          event.cashlessRequestedAt = null;
          event.cashlessRequestedBy = undefined;
          event.cashlessRequestNote = null;
        }
      }
      if (updates.category) event.category = updates.category;
      if (updates.ticketing) event.ticketing = updates.ticketing;
      if (updates.externalTicketUrl !== undefined) event.externalTicketUrl = updates.externalTicketUrl;
      if (updates.currency) event.currency = updates.currency;
      if (updates.priceMin !== undefined) event.priceMin = updates.priceMin;
      if (updates.priceMax !== undefined) event.priceMax = updates.priceMax;
      // Vote question inputs. Deliberately NOT part of the core-info lock
      // above — an organizer may keep refining the lineup/outfit options
      // after publishing. This can't retroactively change a Vote question
      // that has already been materialized (see vote.service's
      // ensureVoteQuestions — options are snapshotted once, at first read
      // after the Vote opens, and never re-synced from the event).
      if (updates.lineup !== undefined) event.lineup = updates.lineup;
      if (updates.outfitThemeOptions !== undefined) event.outfitThemeOptions = updates.outfitThemeOptions;

      // Update ticket types if provided.
      //
      // A tier is EDITED IN PLACE, never rebuilt. Replacing the array (which
      // this used to do) mints fresh subdocument _ids, and every tier lookup in
      // the codebase resolves by _id — `ticketTypes.find(tt => tt._id === ...)`
      // in checkTicketAvailability, reserveTickets, the purchase paths — so a
      // rebuild silently orphans every ticket already issued against the tier.
      // It also dropped each tier's reseller-allocation fields (resellerId,
      // isAllocation, allocationUnitCost, restrictToMethod, waiveServiceFee),
      // quietly turning a partner's exclusive block into an ordinary tier.
      // Mutating the existing subdocument keeps both intact by construction:
      // only the fields the caller actually sent are touched.
      if (updates.ticketTypes) {
        const incoming = updates.ticketTypes;

        // Identity, best signal first: the tier's own _id when the caller
        // echoes it back, else its name. Name-matching alone cannot survive a
        // rename — it reads as "delete tier A, create tier B", resetting the
        // sold count — so a caller that wants to rename a tier MUST send _id.
        const matchExisting = (tt: (typeof incoming)[number]) =>
          tt._id
            ? event.ticketTypes.find(existing => existing._id?.toString() === tt._id)
            : event.ticketTypes.find(existing => existing.name === tt.name);

        // Resolve every incoming tier to its existing subdocument (or null for a
        // new one) ONCE, up front, so the membership check below and the rebuild
        // that follows can never disagree about what matched.
        const matched = new Set<string>();
        const resolved = incoming.map(tt => {
          const existing = matchExisting(tt);
          // An _id the caller made up (or one belonging to a different event)
          // must not quietly become a brand-new tier — that is how an "edit"
          // turns into a duplicate nobody asked for.
          if (tt._id && !existing) {
            throw new HttpError(400, `Unknown ticket type: ${tt._id}`);
          }
          if (existing) {
            const key = existing._id!.toString();
            // Two payload entries pointing at one tier would put the same
            // subdocument in the array twice.
            if (matched.has(key)) {
              throw new HttpError(400, `Duplicate ticket type in update: ${existing.name}`);
            }
            matched.add(key);
          }
          return { tt, existing };
        });

        // Dropping a tier that has already moved tickets would strand the
        // holders of those tickets — their tier simply ceases to exist. Refuse
        // loudly rather than deleting the record out from under them. (A tier
        // nobody has bought into is free to go.)
        const stranded = event.ticketTypes.filter(
          existing =>
            !matched.has(existing._id!.toString()) &&
            (existing.sold > 0 || (existing.reserved || 0) > 0)
        );
        if (stranded.length > 0) {
          throw new HttpError(
            400,
            `Cannot remove ticket type${stranded.length > 1 ? 's' : ''} with tickets already sold: ${stranded
              .map(t => t.name)
              .join(', ')}`
          );
        }

        // Rebuild the ARRAY (order + membership follow the caller) out of the
        // EXISTING subdocuments, so identity and every untouched field ride
        // along. Only genuinely new tiers are constructed from scratch.
        const next = resolved.map(({ tt, existing }) => {
          if (!existing) {
            return {
              name: tt.name,
              description: tt.description,
              price: tt.price,
              quantity: tt.quantity,
              sold: 0,
              reserved: 0,
              available: tt.quantity,
              isSoldOut: tt.isSoldOut ?? false
            } as ITicketType;
          }
          existing.name = tt.name;
          existing.price = tt.price;
          existing.quantity = tt.quantity;
          // description is optional in the payload, so an absent one means
          // "leave it alone", not "erase it" — the caller that never sends
          // descriptions must not silently strip them off every tier.
          if (tt.description !== undefined) existing.description = tt.description;
          // sold/reserved are ledger state owned by the purchase paths — the
          // caller never gets to set them, only to have `available` re-derived.
          existing.available = computeAvailable({
            quantity: tt.quantity,
            sold: existing.sold,
            reserved: existing.reserved || 0
          });
          if (tt.isSoldOut !== undefined) existing.isSoldOut = tt.isSoldOut;
          return existing;
        });

        event.ticketTypes = next as any;
      }

      await event.save();
      return event;
    } catch (error: any) {
      // Preserve intentional HttpErrors (e.g. the 403 rename guard) — wrapping
      // them in a plain Error here would strip the status and surface as a 500.
      if (error instanceof HttpError) throw error;
      console.error('Update event error:', error);
      throw new Error(error.message || 'Failed to update event');
    }
  }

  /**
   * Organizer asks Carrot to make this event cashless. Deliberately NOT a
   * self-serve toggle — see the gate in updateEvent. The request is a stamp on
   * the event rather than its own collection: there is at most one open request
   * per event, and granting it (admin sets cashless) clears the stamp, so a
   * separate lifecycle would carry no information the event doesn't already hold.
   */
  static async requestCashless(
    eventId: string,
    vendorId: string,
    note?: string
  ): Promise<IEvent> {
    // Scoped by vendorId: another organizer's event must read as absent, not
    // as forbidden — the same shape getEventById uses.
    const event = await Event.findOne({ _id: eventId, vendorId });
    if (!event) {
      throw new HttpError(404, 'Event not found');
    }
    if (event.cashless) {
      throw new HttpError(409, 'Event is already cashless');
    }

    // Re-requesting refreshes the ask instead of stacking a duplicate.
    event.cashlessRequestedAt = new Date();
    event.cashlessRequestedBy = vendorId;
    event.cashlessRequestNote = note?.trim() || null;
    await event.save();
    return event;
  }

  /**
   * Delete event (soft delete - only allowed if no tickets sold)
   */
  static async deleteEvent(eventId: string, vendorId: string, isSuperAdmin: boolean = false): Promise<void> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      // Deleting an event with sold tickets destroys buyers' records, so it's
      // blocked for organizers (they should cancel instead). Admins can override.
      if (event.totalTicketsSold > 0 && !isSuperAdmin) {
        throw new Error('Cannot delete event with sold tickets. Cancel the event instead.');
      }

      // Delete event
      await Event.deleteOne({ _id: eventId });
    } catch (error: any) {
      console.error('Delete event error:', error);
      throw new Error(error.message || 'Failed to delete event');
    }
  }

  /**
   * Publish event.
   *
   * Approval is per-EVENT, not per-organizer-account:
   *  - A regular organizer clicking "Publish" SUBMITS the event for approval
   *    (DRAFT → PENDING_APPROVAL). It does not go live yet, but the action
   *    always succeeds — no silent failure, no "verify your account" wall.
   *  - A superadmin publishing IS the approval (DRAFT or PENDING_APPROVAL →
   *    PUBLISHED), making the event live and sellable immediately.
   *
   * An inactive (suspended) organizer is still blocked outright — that's an
   * account-level sanction, distinct from the per-event approval flow.
   */
  static async publishEvent(eventId: string, vendorId: string, isSuperAdmin: boolean = false): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      if (event.status === EventStatus.PUBLISHED) {
        throw new Error('Event is already published');
      }
      if (event.status === EventStatus.CANCELLED || event.status === EventStatus.COMPLETED) {
        throw new Error(`Cannot publish a ${event.status.toLowerCase()} event`);
      }

      if (isSuperAdmin) {
        // Admin approval — the event goes live.
        event.status = EventStatus.PUBLISHED;
        event.publishedAt = new Date();
        // The Community tab is the event page's default tab — the community
        // must exist the moment the event goes live. Runs BEFORE the status
        // commit so a community failure aborts the publish instead of leaving
        // a live event whose publish "failed". ensureForEvent is idempotent;
        // an orphan community from a later save failure is simply adopted by
        // the next publish attempt.
        await CommunityService.ensureForEvent(String(event._id), String(event.vendorId));
      } else {
        // Organizer submission — block only suspended/inactive accounts, then
        // route the event into the approval queue.
        const vendor = await Vendor.findById(event.vendorId).select('isActive');
        if (!vendor) {
          throw new Error('Organizer account not found');
        }
        if (!vendor.isActive) {
          throw new Error('Your organizer account is inactive. Please contact support.');
        }

        if (event.status === EventStatus.PENDING_APPROVAL) {
          throw new Error('Event has already been submitted and is awaiting approval');
        }
        event.status = EventStatus.PENDING_APPROVAL;
      }

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Publish event error:', error);
      throw new Error(error.message || 'Failed to publish event');
    }
  }

  /**
   * Unpublish event (revert to draft)
   */
  static async unpublishEvent(eventId: string, vendorId: string, isSuperAdmin: boolean = false): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      // Both live events and events still awaiting approval can be pulled back
      // to draft (a published event is unpublished; a pending one is withdrawn).
      if (event.status !== EventStatus.PUBLISHED && event.status !== EventStatus.PENDING_APPROVAL) {
        throw new Error('Event is not published');
      }

      // Selling tickets then unpublishing strands buyers, so it's blocked for
      // organizers. Admins can override (e.g. to pull a problem event offline).
      if (event.totalTicketsSold > 0 && !isSuperAdmin) {
        throw new Error('Cannot unpublish event with sold tickets');
      }

      event.status = EventStatus.DRAFT;
      event.publishedAt = undefined;

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Unpublish event error:', error);
      throw new Error(error.message || 'Failed to unpublish event');
    }
  }

  /**
   * Cancel event
   */
  static async cancelEvent(
    eventId: string,
    vendorId: string,
    reason?: string
  ): Promise<IEvent> {
    try {
      const event = await Event.findOne({ _id: eventId, vendorId });

      if (!event) {
        throw new Error('Event not found');
      }

      if (event.status === EventStatus.CANCELLED) {
        throw new Error('Event is already cancelled');
      }

      if (event.status === EventStatus.COMPLETED) {
        throw new Error('Cannot cancel completed event');
      }

      event.status = EventStatus.CANCELLED;
      event.cancelledAt = new Date();
      if (reason) event.cancellationReason = reason;

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Cancel event error:', error);
      throw new Error(error.message || 'Failed to cancel event');
    }
  }

  /**
   * Mark event as completed (after event date has passed)
   */
  static async completeEvent(eventId: string, vendorId: string): Promise<IEvent> {
    try {
      const event = await Event.findOne({ _id: eventId, vendorId });

      if (!event) {
        throw new Error('Event not found');
      }

      if (event.status === EventStatus.COMPLETED) {
        throw new Error('Event is already completed');
      }

      if (event.status === EventStatus.CANCELLED) {
        throw new Error('Cannot complete cancelled event');
      }

      event.status = EventStatus.COMPLETED;

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Complete event error:', error);
      throw new Error(error.message || 'Failed to complete event');
    }
  }

  /**
   * Update ticket sold count for event
   */
  static async updateTicketsSold(
    eventId: string,
    ticketTypeId: string,
    quantity: number,
    revenue: number
  ): Promise<void> {
    try {
      const event = await Event.findById(eventId);

      if (!event) {
        throw new Error('Event not found');
      }

      // Update ticket type sold count
      const ticketTypeObj = event.ticketTypes.find(tt => tt._id?.toString() === ticketTypeId);
      if (ticketTypeObj) {
        ticketTypeObj.sold += quantity;
        ticketTypeObj.available = computeAvailable({ quantity: ticketTypeObj.quantity, sold: ticketTypeObj.sold, reserved: ticketTypeObj.reserved });
      }

      // Update event totals. Attendance/inventory always counts these seats,
      // but an allocation tier's proceeds belong to the reseller (held for
      // their settlement) — the organizer was already paid off-platform — so
      // they must NOT land on the organizer's revenue line.
      event.totalTicketsSold += quantity;
      if (!ticketTypeObj?.isAllocation) {
        event.totalRevenue += revenue;
      }

      await event.save();
    } catch (error: any) {
      console.error('Update tickets sold error:', error);
      throw new Error(error.message || 'Failed to update tickets sold');
    }
  }

  /**
   * Check if tickets are available for purchase
   */
  static async checkTicketAvailability(
    eventId: string,
    ticketTypeId: string,
    quantity: number,
    method?: PaymentMethod,
    buyer?: { buyerId?: string | mongoose.Types.ObjectId | null; phone?: string | null }
  ): Promise<{ available: boolean; message?: string; ticketTypeData?: ITicketType }> {
    try {
      const event = await Event.findById(eventId);

      if (!event) {
        return { available: false, message: 'Event not found' };
      }

      if (event.status !== EventStatus.PUBLISHED) {
        return { available: false, message: `Event is ${event.status.toLowerCase()}` };
      }

      const ticketTypeObj = event.ticketTypes.find(tt => tt._id?.toString() === ticketTypeId);
      if (!ticketTypeObj) {
        return { available: false, message: 'Ticket type not found' };
      }

      // Per-tier payment-method restriction (e.g. a reseller's DeltaPay-exclusive
      // block). Only enforced when a method is supplied AND the tier is
      // restricted, so unrestricted tiers and callers that don't pass a method
      // behave exactly as before.
      if (ticketTypeObj.restrictToMethod && method && method !== ticketTypeObj.restrictToMethod) {
        return {
          available: false,
          message: `This ticket can only be bought with ${ticketTypeObj.restrictToMethod}`,
          ticketTypeData: ticketTypeObj
        };
      }

      // Organizer's manual "mark sold out" override. This is the single gate
      // every async payment path (MoMo, Peach card, DeltaPay) funnels through,
      // so enforcing the flag here — not just in the count check — is what
      // makes "sold out" actually stop a sale. A manually sold-out tier keeps a
      // positive computeAvailable() (the dashboard only flips the flag), so
      // relying on the count alone would let it keep selling.
      if (ticketTypeObj.isSoldOut) {
        return {
          available: false,
          message: 'This ticket type is sold out',
          ticketTypeData: ticketTypeObj
        };
      }

      if (computeAvailable(ticketTypeObj) < quantity) {
        return {
          available: false,
          message: `Only ${computeAvailable(ticketTypeObj)} tickets available`,
          ticketTypeData: ticketTypeObj
        };
      }

      // Per-account cap ("one ticket per person"). Enforced only when the
      // organizer set a positive maxTicketsPerAccount AND we can identify the
      // buyer (buyerId or a phone). Counts the buyer's ACTIVE tickets for THIS
      // event across all tiers (refunded/cancelled excluded) and rejects if
      // this order would push them over the cap. A caller with no identity
      // (POS walk-up, wristband, reseller allocation) is skipped — an account
      // rule can't bind someone with no account and no phone.
      const cap = event.maxTicketsPerAccount;
      if (typeof cap === 'number' && cap > 0 && buyer) {
        const identityClauses: Array<Record<string, unknown>> = [];
        if (buyer.buyerId) identityClauses.push({ buyerId: buyer.buyerId });
        const normPhone = buyer.phone ? normalizePhone(buyer.phone) : '';
        if (normPhone) identityClauses.push({ customerPhone: normPhone });

        if (identityClauses.length > 0) {
          const held = await Ticket.countDocuments({
            eventId,
            status: { $nin: [TicketStatus.REFUNDED, TicketStatus.CANCELLED] },
            $or: identityClauses,
          });
          if (held + quantity > cap) {
            return {
              available: false,
              message:
                cap === 1
                  ? "You already have your ticket for this event — it's limited to one per person."
                  : `This event is limited to ${cap} tickets per person; you already have ${held}.`,
              ticketTypeData: ticketTypeObj,
            };
          }
        }
      }

      return {
        available: true,
        ticketTypeData: ticketTypeObj
      };
    } catch (error: any) {
      console.error('Check ticket availability error:', error);
      return { available: false, message: error.message || 'Error checking availability' };
    }
  }

  /**
   * Add a new ticket type to an event
   */
  static async addTicketType(
    eventId: string,
    vendorId: string,
    ticketType: {
      name: string;
      description?: string;
      price: number;
      quantity: number;
      // Reseller allocation (super-admin only): a block a reseller pre-bought.
      resellerId?: string;
      isAllocation?: boolean;
      allocationUnitCost?: number;
      restrictToMethod?: PaymentMethod;
      waiveServiceFee?: boolean;
    },
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      // An allocation tier reroutes money to a reseller and off the organizer's
      // books — only Carrot (super-admin) sets those up, and it MUST name the
      // reseller. Fail loudly rather than silently create a mis-attributed tier.
      if (ticketType.isAllocation) {
        if (!isSuperAdmin) {
          throw new Error('Only a super-admin can create an allocation tier');
        }
        if (!ticketType.resellerId) {
          throw new Error('An allocation tier requires a reseller');
        }
      }

      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      // Check if ticket type with same name already exists
      const existing = event.ticketTypes.find(tt => tt.name.toLowerCase() === ticketType.name.toLowerCase());
      if (existing) {
        throw new Error(`Ticket type "${ticketType.name}" already exists`);
      }

      // Add new ticket type
      event.ticketTypes.push({
        name: ticketType.name,
        description: ticketType.description,
        price: ticketType.price,
        quantity: ticketType.quantity,
        sold: 0,
        reserved: 0,
        available: ticketType.quantity,
        isSoldOut: false,
        // Allocation metadata is applied only for a super-admin-created block.
        ...(ticketType.isAllocation
          ? {
              resellerId: new mongoose.Types.ObjectId(ticketType.resellerId),
              isAllocation: true,
              ...(ticketType.allocationUnitCost != null ? { allocationUnitCost: ticketType.allocationUnitCost } : {}),
              ...(ticketType.restrictToMethod ? { restrictToMethod: ticketType.restrictToMethod } : {}),
              ...(ticketType.waiveServiceFee ? { waiveServiceFee: true } : {}),
            }
          : {}),
      } as any);

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Add ticket type error:', error);
      throw new Error(error.message || 'Failed to add ticket type');
    }
  }

  /**
   * Update an existing ticket type
   */
  static async updateTicketType(
    eventId: string,
    vendorId: string,
    ticketTypeName: string,
    updates: {
      name?: string;
      description?: string;
      price?: number;
      quantity?: number;
    },
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      const ticketType = event.ticketTypes.find(tt => tt.name === ticketTypeName);
      if (!ticketType) {
        throw new Error('Ticket type not found');
      }

      // Check if any tickets have been sold
      if (ticketType.sold > 0) {
        // Only allow updating description and increasing quantity
        if (updates.name || updates.price !== undefined) {
          throw new Error('Cannot change name or price of ticket type with sold tickets');
        }
        if (updates.quantity !== undefined && updates.quantity < ticketType.sold) {
          throw new Error(`Cannot reduce quantity below sold count (${ticketType.sold})`);
        }
      }

      // Update fields
      if (updates.name) ticketType.name = updates.name;
      if (updates.description !== undefined) ticketType.description = updates.description;
      if (updates.price !== undefined) ticketType.price = updates.price;
      if (updates.quantity !== undefined) {
        ticketType.quantity = updates.quantity;
        ticketType.available = computeAvailable({ quantity: updates.quantity, sold: ticketType.sold, reserved: ticketType.reserved });
      }

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Update ticket type error:', error);
      throw new Error(error.message || 'Failed to update ticket type');
    }
  }

  /**
   * Delete a ticket type (only if no tickets sold)
   */
  static async deleteTicketType(
    eventId: string,
    vendorId: string,
    ticketTypeName: string,
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      const ticketType = event.ticketTypes.find(tt => tt.name === ticketTypeName);
      if (!ticketType) {
        throw new Error('Ticket type not found');
      }

      // Check if any tickets have been sold
      if (ticketType.sold > 0) {
        throw new Error('Cannot delete ticket type with sold tickets');
      }

      // Remove ticket type
      event.ticketTypes = event.ticketTypes.filter(tt => tt.name !== ticketTypeName);

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Delete ticket type error:', error);
      throw new Error(error.message || 'Failed to delete ticket type');
    }
  }

  /**
   * Adjust ticket quantity (increase or decrease)
   */
  static async adjustTicketQuantity(
    eventId: string,
    vendorId: string,
    ticketTypeName: string,
    adjustment: number,
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      const ticketType = event.ticketTypes.find(tt => tt.name === ticketTypeName);
      if (!ticketType) {
        throw new Error('Ticket type not found');
      }

      const newQuantity = ticketType.quantity + adjustment;

      // Validate new quantity
      if (newQuantity < ticketType.sold) {
        throw new Error(`Cannot reduce quantity below sold count (${ticketType.sold})`);
      }

      if (newQuantity < 0) {
        throw new Error('Quantity cannot be negative');
      }

      // Update quantity
      ticketType.quantity = newQuantity;
      ticketType.available = computeAvailable({ quantity: newQuantity, sold: ticketType.sold, reserved: ticketType.reserved });

      // Recalculate event capacity from all ticket types
      event.capacity = event.ticketTypes.reduce((sum, tt) => sum + tt.quantity, 0);

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Adjust ticket quantity error:', error);
      throw new Error(error.message || 'Failed to adjust ticket quantity');
    }
  }

  /**
   * Mark ticket type as sold out (manual override)
   */
  static async markTicketSoldOut(
    eventId: string,
    vendorId: string,
    ticketTypeName: string,
    isSoldOut: boolean,
    isSuperAdmin: boolean = false
  ): Promise<IEvent> {
    try {
      const query: any = { _id: eventId };
      if (!isSuperAdmin) {
        query.vendorId = vendorId;
      }
      const event = await Event.findOne(query);

      if (!event) {
        throw new Error('Event not found');
      }

      const ticketType = event.ticketTypes.find(tt => tt.name === ticketTypeName);
      if (!ticketType) {
        throw new Error('Ticket type not found');
      }

      ticketType.isSoldOut = isSoldOut;

      await event.save();
      return event;
    } catch (error: any) {
      console.error('Mark ticket sold out error:', error);
      throw new Error(error.message || 'Failed to update sold out status');
    }
  }
}
