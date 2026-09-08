import { Document, Types } from 'mongoose';
import { EventCurrency } from '@utils/currency.util';

export enum TicketStatus {
  AVAILABLE = 'available',
  SOLD = 'sold',
  CHECKED_IN = 'checked_in',
  REFUNDED = 'refunded',
  CANCELLED = 'cancelled'
}

export enum TicketPdfStatus {
  PENDING = 'pending',
  GENERATING = 'generating',
  READY = 'ready',
  FAILED = 'failed'
}

export enum PaymentMethod {
  CASH = 'cash',
  KESHLESS_WALLET = 'keshless_wallet',
  MTN_MOMO = 'mtn_momo',
  PEACH_CARD = 'peach_card',
  DELTAPAY = 'deltapay',
  YOCO = 'yoco',
  YEBOPAY = 'yebopay'
}

export enum PaymentStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded'
}

export enum SalesChannel {
  ONLINE = 'online',          // buyer self-service web/app checkout
  BOX_OFFICE = 'box_office',  // vendor/sub-user selling in person
  RESELLER_POS = 'reseller_pos', // reseller operator sale
  WRISTBAND = 'wristband'     // platform-printed wristband batch (zero-amount)
}

export interface ITicket extends Document {
  _id: Types.ObjectId;

  // Ticket Identification
  ticketId: string; // TKT-{timestamp}-{random} - QR scannable
  eventId: Types.ObjectId;
  vendorId: Types.ObjectId;

  // Ticket Details
  ticketType: string; // VIP, Regular, etc.
  price: number;
  // Snapshot of the event's DISPLAY currency at mint time — see ticket.model.ts.
  currency?: EventCurrency;

  // Ownership
  purchasedBy?: Types.ObjectId; // User ID (if from Keshless app)
  customerName?: string; // For cash/walk-in purchases
  customerPhone?: string;
  customerEmail?: string; // Buyer email for email-based identity
  buyerId?: Types.ObjectId; // Ref to Buyer (for email/phone identity)
  saleId?: Types.ObjectId; // Link to sale transaction

  // Status
  status: TicketStatus;

  // Entry Tracking
  checkedInAt?: Date;
  checkedInBy?: Types.ObjectId; // Staff who scanned
  checkedInByModel?: string; // 'Vendor' or 'VendorSubUser'

  // Shareable PDF (generated on demand, cached in R2). Lets the user-app and
  // the keshless-tickets web/dashboard share the SAME ticket PDF.
  pdfUrl?: string;
  pdfStatus?: TicketPdfStatus;
  pdfRequestedAt?: Date; // when generation last started — used to recover from a stalled 'generating'

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Methods
  checkIn(scannerId: string, scannerModel: string): Promise<ITicket>;
  isValidForEntry(): boolean;
}

export interface ITicketSale extends Document {
  _id: Types.ObjectId;

  // Sale Identification
  saleId: string; // SALE-{timestamp}-{random}
  eventId: Types.ObjectId;
  vendorId: Types.ObjectId;

  // Tickets Sold
  ticketIds: Types.ObjectId[]; // Array of ticket IDs
  /** Composition snapshot — see the model for why the async rails need it.
   *  Absent on sales written before multi-tier checkout. */
  lines?: Array<{ ticketTypeId: string; ticketTypeName: string; unitPrice: number; quantity: number }>;
  quantity: number;

  // Customer Info
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string; // Buyer email for email-based identity
  buyerId?: Types.ObjectId; // Ref to Buyer (for email/phone identity)
  customerUserId?: Types.ObjectId; // If purchased via Keshless app

  // Payment
  totalAmount: number;
  // DISPLAY currency snapshot (from event.currency) — what buyer/organizer see.
  currency?: EventCurrency;
  // Rail-native SETTLEMENT currency actually used (card→ZAR, else→SZL). See
  // ticketSale.model.ts for the full explanation.
  settlementCurrency?: EventCurrency;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  walletTransactionId?: string; // Keshless transaction ID
  momoReferenceId?: string;      // MTN MoMo X-Reference-Id (UUID) for async collections
  momoFailureReason?: string;    // MTN failure reason enum (e.g. NOT_ENOUGH_FUNDS) for buyer messaging
  peachPaymentId?: string;       // Peach Payments payment ID for card transactions
  deltapaySessionId?: string;    // DeltaPay hosted-checkout session ID (UUID) for wallet transactions
  yocoCheckoutId?: string;       // Yoco checkout ID (ch_…) for Yoco card transactions
  yebopayCheckoutId?: string;    // YeboPay checkout ID for the YeboPay card rail
  reservationExpiresAt?: Date;   // when a PENDING MoMo reservation lapses

  // Staff
  soldBy: Types.ObjectId; // Staff member who made the sale
  soldByType: 'Vendor' | 'VendorSubUser' | 'ResellerOperator'; // Who sold it

  // Sales channel — "where bought". Orthogonal to soldByType: a vendor sale can
  // be online OR box_office. Set at sale-build time; never null for new sales.
  channel: SalesChannel;

  // Reseller Attribution
  resellerId?: Types.ObjectId;
  hubId?: Types.ObjectId;
  // Denormalized from the ticket tier: this sale is for a reseller ALLOCATION
  // block (pre-bought off-platform, resold on the reseller's behalf). Its money
  // is never the organizer's, so organizer revenue analytics exclude it — while
  // its seats still count toward attendance. Absent on ordinary sales.
  isAllocation?: boolean;

  // Tickets refunded out of this sale (TicketService.refundTicket). The sale
  // stays COMPLETED — the money that was collected was collected — so every
  // revenue / tickets-sold figure reads totalAmount − refundedAmount and
  // quantity − refundedQuantity. Absent on sales written before the counters
  // existed; aggregates treat that as 0 (see analytics NET_SALE_AMOUNT).
  refundedQuantity?: number;
  refundedAmount?: number;

  // Economic Snapshot — immutable, written at sale time
  faceAmount?: number;
  resellerCommissionPercent?: number;
  resellerCommissionAmount?: number;
  platformFeePercent?: number;
  platformFeeAmount?: number;
  serviceFeeAmount?: number;
  /** Booking fee billed to the ORGANIZER instead of the buyer (absorbing events). */
  absorbedServiceFeeAmount?: number;
  amountCharged?: number;
  organizerProceeds?: number;
  fundsCustody?: 'carrot' | 'reseller' | 'vendor';

  // Set true when the covering reseller settlement is closed + paid
  resellerRemitted: boolean;
  commissionWithdrawn?: boolean;

  // Timestamps
  soldAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITicketScan extends Document {
  _id: Types.ObjectId;

  // Scan Details
  ticketId: Types.ObjectId;
  eventId: Types.ObjectId;
  vendorId: Types.ObjectId;

  // Scanner Info
  scannedBy: Types.ObjectId;
  scannedByType: 'Vendor' | 'VendorSubUser' | 'GateOperator';

  // Scan Result
  isValid: boolean;
  scanResult: 'success' | 'already_scanned' | 'invalid_ticket' | 'wrong_event' | 'cancelled';
  notes?: string;

  // Timestamps
  scannedAt: Date;
  createdAt: Date;
}
