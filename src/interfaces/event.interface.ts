import { Document, Types } from 'mongoose';
import type { EventCategory } from '@/constants/eventCategories';
import type { PaymentMethod } from './ticket.interface';

export enum EventStatus {
  DRAFT = 'draft',
  // An organizer has submitted the event to go live, but a Carrot admin must
  // approve it first. Approval is per-EVENT, not per-organizer-account — a
  // pending event sells nothing until a superadmin publishes (approves) it.
  PENDING_APPROVAL = 'pending_approval',
  PUBLISHED = 'published',
  ONGOING = 'ongoing',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled'
}

export type EventTicketing = 'carrot' | 'external';

export interface ITicketType {
  _id?: string; // Ticket type ID (MongoDB ObjectId as string)
  name: string; // e.g., "VIP", "Regular", "Early Bird"
  description?: string;
  price: number;
  quantity: number; // Total tickets of this type
  sold: number; // Number sold
  reserved: number;  // tickets held by in-flight (PENDING) async payments
  available: number; // quantity - sold - reserved
  isSoldOut?: boolean; // Manual sold-out flag

  // Reseller allocation: a block of this tier pre-purchased off-platform by a
  // reseller (e.g. DeltaPay) and resold on their behalf. Sales of an allocation
  // tier are attributed to `resellerId` — held for their settlement and kept
  // OFF the organizer's revenue (see updateTicketsSold / analytics) — while the
  // seats still count toward attendance/capacity.
  resellerId?: Types.ObjectId;
  isAllocation?: boolean;
  allocationUnitCost?: number; // what the reseller paid the organizer per seat
  restrictToMethod?: PaymentMethod; // only this payment method may buy the tier
  waiveServiceFee?: boolean; // no buyer service fee on this tier
}

export interface IEvent extends Document {
  _id: Types.ObjectId;

  // Event Identification
  eventId: string; // EVT-{timestamp}-{random}
  // Optional: a community/self-listed event (submitted by a buyer, pending
  // review) has no owning vendor until an admin approves/assigns it.
  vendorId?: Types.ObjectId;
  // Set when a buyer self-lists an event from the consumer app (published
  // straight away, sells nothing). Mutually exclusive with vendorId.
  submittedByBuyerId?: Types.ObjectId;

  // Event Details
  name: string;
  description?: string;
  venue: string;
  eventDate: Date; // For single-day: event date. For multi-day: start date
  startTime: Date; // For single-day: start time on eventDate. For multi-day: start datetime
  endTime: Date; // For single-day: end time on eventDate. For multi-day: end datetime
  isMultiDay?: boolean; // Whether this is a multi-day event (default: false)
  cashless: boolean; // Whether NFC tap-and-go wallet/POS is enabled for this event (default: false)
  // An organizer cannot switch `cashless` on themselves (it commits Carrot to
  // bands, handhelds, a float and settlement), so they ask and an admin grants.
  // Granting clears the request; these are the whole request record.
  cashlessRequestedAt?: Date | null;
  cashlessRequestedBy?: any;
  cashlessRequestNote?: string | null;

  // Capacity & Tickets
  capacity: number; // Total event capacity
  ticketTypes: ITicketType[]; // Different ticket types
  // Max ACTIVE tickets a single buyer identity may hold for this event, summed
  // across all ticket types. Undefined/absent = unlimited (default). Set to 1
  // for strict "one ticket per person". Enforced in
  // EventService.checkTicketAvailability against buyerId OR normalized
  // customerPhone. No dashboard UI — set via src/scripts/setPerAccountLimit.ts.
  maxTicketsPerAccount?: number;

  // Status
  status: EventStatus;

  // Organizer-set category — powers Home/Discover category chips + poster
  // badge. Never inferred; defaults to 'Other' when unset.
  category: EventCategory;

  // Ticketing mode — 'carrot' sells tickets on-platform (default); 'external'
  // links out to the organizer's own ticket seller (see externalTicketUrl).
  ticketing: EventTicketing;
  externalTicketUrl?: string;

  // Display currency for the event price. 'SZL' shows 'E', 'ZAR' shows 'R'.
  // Snapshotted onto every Ticket/TicketSale minted for this event.
  currency: 'SZL' | 'ZAR';

  /**
   * Organizer covers the buyer's booking fee on this event: online checkout
   * charges exactly face, and the same per-method fee is deducted from the
   * organizer's proceeds instead. Absent/false = the buyer pays it on top.
   */
  organizerAbsorbsServiceFee?: boolean;
  // Organizer-entered display price range for external events (Carrot isn't
  // selling, so there are no ticket tiers to derive a range from).
  priceMin?: number;
  priceMax?: number;

  // Sales Info
  totalTicketsSold: number;
  totalRevenue: number;

  // Discover-feed engagement counters
  likeCount: number;
  saveCount: number;
  shareCount: number;

  // Media & Images
  posterUrl?: string;
  thumbnailUrl?: string;
  galleryImages?: string[];
  qrCodeUrl?: string;

  // Vote feature inputs (see @services/vote.service). Absent/empty means the
  // corresponding Vote question is never shown — nothing is fabricated when
  // an organizer hasn't supplied this information.
  // Performer/artist names for the "Which artist will perform best?" question.
  lineup?: string[];
  // Candidate outfit/dress-code themes for the "Which outfit theme should
  // attendees wear?" question — a poll among organizer-supplied options, not
  // a single fixed dress code.
  outfitThemeOptions?: string[];

  // Publishing
  publishedAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Methods
  getTotalAvailable(): number;
  isSoldOut(): boolean;
}
