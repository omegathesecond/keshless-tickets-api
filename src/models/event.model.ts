import mongoose, { Schema } from 'mongoose';
import { IEvent, EventStatus, ITicketType } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';
import { EVENT_CATEGORIES } from '@/constants/eventCategories';

const ticketTypeSchema = new Schema<ITicketType>({
  name: {
    type: String,
    required: [true, 'Ticket type name is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative']
  },
  quantity: {
    type: Number,
    required: [true, 'Quantity is required'],
    min: [1, 'Quantity must be at least 1']
  },
  sold: {
    type: Number,
    default: 0,
    min: 0
  },
  available: {
    type: Number,
    default: function(this: ITicketType) {
      return this.quantity - this.sold;
    }
  },
  reserved:    { type: Number, default: 0, min: 0 },
  isSoldOut: {
    type: Boolean,
    default: false
  },
  // Reseller allocation (pre-purchased block resold on the reseller's behalf).
  // All optional → absent on ordinary tiers, which keep today's behavior.
  resellerId:        { type: Schema.Types.ObjectId, ref: 'Reseller' },
  isAllocation:      { type: Boolean },
  allocationUnitCost:{ type: Number, min: 0 },
  restrictToMethod:  { type: String, enum: Object.values(PaymentMethod) },
  waiveServiceFee:   { type: Boolean }
}, { _id: true });

const eventSchema = new Schema<IEvent>({
  // Event Identification
  eventId: {
    type: String,
    unique: true,
    index: true
  },
  vendorId: {
    type: Schema.Types.ObjectId,
    ref: 'Vendor',
    // Required for organizer-created events; a buyer self-listed (community)
    // event never has a vendor — nobody sells or gets paid for it — so it's
    // exempt.
    required: [function (this: any) { return !this.submittedByBuyerId; }, 'Vendor ID is required'],
    index: true
  },
  // Buyer who self-listed this event from the consumer app (no vendor, no
  // ticket sales — published without admin review).
  submittedByBuyerId: {
    type: Schema.Types.ObjectId,
    ref: 'Buyer',
    index: true
  },

  // Event Details
  name: {
    type: String,
    required: [true, 'Event name is required'],
    trim: true,
    maxlength: [200, 'Event name cannot exceed 200 characters'],
    index: true
  },
  description: {
    type: String,
    trim: true,
    maxlength: [2000, 'Description cannot exceed 2000 characters']
  },
  venue: {
    type: String,
    required: [true, 'Venue is required'],
    trim: true,
    maxlength: [200, 'Venue cannot exceed 200 characters']
  },
  eventDate: {
    type: Date,
    required: [true, 'Event date is required'],
    index: true
  },
  startTime: {
    type: Date,
    required: [true, 'Start time is required']
  },
  endTime: {
    type: Date,
    required: [true, 'End time is required']
  },
  isMultiDay: {
    type: Boolean,
    default: false
  },
  cashless: {
    type: Boolean,
    default: false
  },
  // Organizer's standing request for cashless (admin grants it — see
  // EventService.requestCashless). Cleared the moment cashless goes on.
  cashlessRequestedAt: {
    type: Date,
    default: null
  },
  cashlessRequestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vendor'
  },
  cashlessRequestNote: {
    type: String,
    trim: true,
    maxlength: 300
  },

  // Capacity & Tickets
  // Capacity is no longer collected at event creation — it is derived from
  // the sum of ticket-type quantities in the pre-save hook below, so the
  // "tickets sold / capacity" figure always matches the tickets that actually
  // exist (previously an organiser could set capacity 500 yet add 1000
  // tickets, producing a misleading 0/500).
  capacity: {
    type: Number,
    default: 0,
    min: [0, 'Capacity cannot be negative']
  },
  ticketTypes: {
    type: [ticketTypeSchema],
    default: []
  },
  // See IEvent.maxTicketsPerAccount. No `default` — absent means unlimited, so
  // every existing event is unaffected. `min: 1` so a stored cap is meaningful.
  maxTicketsPerAccount: {
    type: Number,
    min: [1, 'maxTicketsPerAccount must be at least 1'],
  },

  // Status
  status: {
    type: String,
    enum: Object.values(EventStatus),
    default: EventStatus.DRAFT,
    index: true
  },

  // Organizer-set category — powers Home/Discover category chips + poster
  // badge. Never inferred; defaults to 'Other' when unset.
  category: {
    type: String,
    enum: EVENT_CATEGORIES,
    default: 'Other',
    index: true
  },

  // Ticketing mode — 'carrot' sells tickets on-platform (default); 'external'
  // links out to the organizer's own ticket seller. Existing events have no
  // stored value; the default below makes them read as 'carrot'.
  ticketing: {
    type: String,
    enum: ['carrot', 'external'],
    default: 'carrot',
    index: true
  },
  externalTicketUrl: {
    type: String,
    trim: true,
    maxlength: 500
  },
  currency: {
    type: String,
    enum: ['SZL', 'ZAR'],
    default: 'SZL'
  },
  // Organizer covers the buyer's booking fee: online checkout charges exactly
  // face, and the fee is deducted from organizerProceeds instead. Deliberately
  // has NO schema default so existing events read `undefined` (falsy) rather
  // than being rewritten — only events explicitly flagged absorb anything.
  organizerAbsorbsServiceFee: { type: Boolean },
  priceMin: {
    type: Number,
    min: [0, 'Price cannot be negative']
  },
  priceMax: {
    type: Number,
    min: [0, 'Price cannot be negative']
  },

  // Sales Info
  totalTicketsSold: {
    type: Number,
    default: 0,
    min: 0
  },
  totalRevenue: {
    type: Number,
    default: 0,
    min: 0
  },

  // Discover-feed engagement counters. Events created before this field exists
  // have no value stored; `.lean()` reads (feed.service.ts) do NOT apply schema
  // defaults to absent fields, so every read site must use `?? 0`.
  likeCount: { type: Number, default: 0 },
  // Distinct bookmark-reaction counter, independent of likeCount — mirrors
  // Update's likeCount/saveCount split (see EventReaction's 'save' type).
  saveCount: { type: Number, default: 0 },
  shareCount: { type: Number, default: 0 },

  // Media & Images
  posterUrl: {
    type: String,
    trim: true
  },
  thumbnailUrl: {
    type: String,
    trim: true
  },
  galleryImages: {
    type: [String],
    default: []
  },
  qrCodeUrl: {
    type: String,
    trim: true
  },

  // Vote feature inputs — see IEvent.lineup / outfitThemeOptions. No
  // schema default: absent means the Vote question they gate is skipped
  // entirely, never rendered with fabricated options.
  lineup: {
    type: [String],
    default: undefined
  },
  outfitThemeOptions: {
    type: [String],
    default: undefined
  },

  // Publishing
  publishedAt: {
    type: Date
  },
  cancelledAt: {
    type: Date
  },
  cancellationReason: {
    type: String,
    maxlength: 500
  }
}, {
  timestamps: true
});

// Pre-save hook to generate eventId
eventSchema.pre('save', function(next) {
  if (this.isNew && !this.eventId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    this.eventId = `EVT-${timestamp}-${random}`;
  }
  next();
});

// Pre-save hook to update ticket availability and total sold
eventSchema.pre('save', function(next) {
  if (this.ticketTypes && this.ticketTypes.length > 0) {
    // Update available count for each ticket type
    this.ticketTypes.forEach(ticketType => {
      ticketType.available = Math.max(0, ticketType.quantity - ticketType.sold - (ticketType.reserved || 0));
    });

    // Calculate total tickets sold across all ticket types
    this.totalTicketsSold = this.ticketTypes.reduce((sum, ticketType) => {
      return sum + ticketType.sold;
    }, 0);

    // Derive capacity from the total tickets created across all types so the
    // "sold / capacity" figure can never contradict the tickets that exist.
    this.capacity = this.ticketTypes.reduce((sum, ticketType) => {
      return sum + ticketType.quantity;
    }, 0);
  }
  next();
});

// Method to get total tickets available across all types
eventSchema.methods.getTotalAvailable = function(this: IEvent): number {
  return this.ticketTypes.reduce((sum: number, type: ITicketType) => sum + type.available, 0);
};

// Method to check if event is sold out
eventSchema.methods.isSoldOut = function(this: IEvent): boolean {
  return (this as any).getTotalAvailable() === 0;
};

// Indexes
eventSchema.index({ vendorId: 1, status: 1 });
eventSchema.index({ eventDate: 1, status: 1 });
eventSchema.index({ vendorId: 1, eventDate: -1 });
// Activity feed: newest-first scan of published events ("announced").
eventSchema.index({ status: 1, publishedAt: -1 });

export const Event = mongoose.model<IEvent>('Event', eventSchema);
