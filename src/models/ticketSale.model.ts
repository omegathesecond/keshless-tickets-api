import mongoose, { Schema } from 'mongoose';
import { ITicketSale, PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';

const ticketSaleSchema = new Schema<ITicketSale>({
  // Sale Identification
  saleId: {
    type: String,
    unique: true,
    index: true
  },
  eventId: {
    type: Schema.Types.ObjectId,
    ref: 'Event',
    required: [true, 'Event ID is required'],
    index: true
  },
  vendorId: {
    type: Schema.Types.ObjectId,
    ref: 'Vendor',
    required: [true, 'Vendor ID is required'],
    index: true
  },

  // Tickets Sold
  ticketIds: [{
    type: Schema.Types.ObjectId,
    ref: 'Ticket',
    required: true
  }],
  quantity: {
    type: Number,
    required: [true, 'Quantity is required'],
    min: [1, 'Quantity must be at least 1']
  },
  /**
   * What this sale is COMPOSED of, snapshotted at checkout: one entry per
   * tier, with the price as it stood when the buyer agreed to it.
   *
   * Load-bearing for the async rails (MoMo, Peach, Yoco, YeboPay, DeltaPay),
   * which create the sale now and mint from a webhook later. Without it a
   * finalizer can only reconstruct `quantity` tickets of one tier at
   * `totalAmount / quantity` — an AVERAGE price, which is right only when
   * every ticket costs the same, and silently wrong for a mixed cart.
   * Re-reading the tier at finalize is not an alternative: the organizer may
   * have edited its price in between, and the buyer agreed to the old one.
   *
   * Absent on sales written before multi-tier checkout; those all predate any
   * mixed cart, so nothing reads this without checking.
   */
  lines: {
    type: [new Schema({
      ticketTypeId: { type: String, required: true },
      ticketTypeName: { type: String, required: true },
      unitPrice: { type: Number, required: true, min: 0 },
      quantity: { type: Number, required: true, min: 1 },
    }, { _id: false })],
    default: undefined,
  },

  // Customer Info
  customerName: {
    type: String,
    trim: true,
    maxlength: [100, 'Customer name cannot exceed 100 characters']
  },
  customerPhone: {
    type: String,
    trim: true
  },
  customerEmail: {
    type: String,
    trim: true,
    lowercase: true,
    index: true
  },
  buyerId: {
    type: Schema.Types.ObjectId,
    ref: 'Buyer',
    index: true,
    sparse: true
  },
  customerUserId: {
    type: Schema.Types.ObjectId,
    ref: 'User', // Keshless user
    sparse: true
  },

  // Payment
  totalAmount: {
    type: Number,
    required: [true, 'Total amount is required'],
    min: [0, 'Total amount cannot be negative']
  },
  // DISPLAY currency snapshot (from event.currency) — what buyer/organizer see.
  currency: {
    type: String,
    enum: ['SZL', 'ZAR'],
    default: 'SZL'
  },
  // Rail-native SETTLEMENT currency actually used (card→ZAR, else→SZL). May
  // differ from `currency` at par (e.g. a ZAR event paid via MoMo settles SZL).
  // Recorded for honest reconciliation; the verify guards are unchanged.
  settlementCurrency: {
    type: String,
    enum: ['SZL', 'ZAR']
  },
  paymentMethod: {
    type: String,
    enum: Object.values(PaymentMethod),
    required: [true, 'Payment method is required'],
    index: true
  },
  paymentStatus: {
    type: String,
    enum: Object.values(PaymentStatus),
    default: PaymentStatus.PENDING,
    index: true
  },
  walletTransactionId: {
    type: String,
    sparse: true,
    trim: true
  },
  momoReferenceId: {
    type: String,
    sparse: true,
    index: true,
    trim: true
  },
  // MTN's failure reason enum (e.g. NOT_ENOUGH_FUNDS, PAYER_NOT_FOUND, EXPIRED)
  // captured at finalize so a poll arriving AFTER the callback can still tell the
  // buyer why it failed. Stored verbatim; the frontend maps it to friendly copy.
  momoFailureReason: {
    type: String,
    trim: true
  },
  peachPaymentId: {
    type: String,
    sparse: true,
    index: true,
    trim: true
  },
  // DeltaPay hosted-checkout session ID (UUID). Sole lookup key for the return
  // redirect, the session callback, the buyer poll and the reconcile sweep.
  deltapaySessionId: {
    type: String,
    sparse: true,
    index: true,
    trim: true
  },
  // Yoco checkout ID (ch_…). Sole lookup key for the signed webhook, the return
  // redirect and the buyer poll. Yoco has NO status-query endpoint, so unlike
  // peachPaymentId there is no reconcile-by-asking-the-provider path off this.
  yocoCheckoutId: {
    type: String,
    sparse: true,
    index: true,
    trim: true
  },
  // YeboPay checkout ID. Unlike Yoco, YeboPay DOES publish a status endpoint
  // (GET /v1/checkouts/:id), so this key also drives reconcilePendingYeboPaySales —
  // a sale whose webhook never arrived can be resolved by asking, not just reported.
  yebopayCheckoutId: {
    type: String,
    sparse: true,
    index: true,
    trim: true,
  },
  reservationExpiresAt: {
    type: Date,
    index: true
  },

  // Staff
  soldBy: {
    type: Schema.Types.ObjectId,
    required: [true, 'Seller ID is required'],
    refPath: 'soldByType'
  },
  soldByType: {
    type: String,
    required: true,
    enum: ['Vendor', 'VendorSubUser', 'ResellerOperator'],
    default: 'Vendor'
  },

  // Sales channel — "where bought"
  channel: {
    type: String,
    enum: Object.values(SalesChannel),
    index: true
  },

  // Reseller Attribution
  resellerId: { type: Schema.Types.ObjectId, ref: 'Reseller', index: true, sparse: true },
  hubId: { type: Schema.Types.ObjectId, ref: 'ResellerHub', index: true, sparse: true },
  // Allocation-block sale (see ITicketSale.isAllocation). Sparse-indexed so the
  // analytics revenue filter `isAllocation: { $ne: true }` stays cheap.
  isAllocation: { type: Boolean, index: true, sparse: true },
  // Refund counters — see ITicketSale.refundedQuantity. Aggregates read them
  // via $ifNull so sales written before the fields existed count as 0.
  refundedQuantity: { type: Number, default: 0, min: 0 },
  refundedAmount: { type: Number, default: 0, min: 0 },

  // Economic snapshot — immutable, written at sale time
  faceAmount: { type: Number },
  resellerCommissionPercent: { type: Number, default: 0 },
  resellerCommissionAmount: { type: Number, default: 0 },
  platformFeePercent: { type: Number, default: 0 },
  platformFeeAmount: { type: Number, default: 0 },
  // Buyer-paid FLAT service fee (online checkout, on top of face). totalAmount
  // stays face value; amountCharged = totalAmount + serviceFeeAmount is what the
  // buyer was actually charged and what the MoMo/card callback guards verify.
  serviceFeeAmount: { type: Number, default: 0 },
  // Non-zero only for events flagged organizerAbsorbsServiceFee: the buyer paid
  // face, and this is the booking fee the organizer covers — already netted out
  // of organizerProceeds, so settlement needs no special case.
  absorbedServiceFeeAmount: { type: Number, default: 0 },
  amountCharged: { type: Number },
  organizerProceeds: { type: Number },
  fundsCustody: { type: String, enum: ['carrot', 'reseller', 'vendor'] },

  // Set true when the covering reseller settlement is closed + paid
  resellerRemitted: { type: Boolean, default: false, index: true },
  commissionWithdrawn: { type: Boolean, default: false, index: true },

  // Share&Earn referral attribution — see ITicketSale.shareEarnReferralCode.
  shareEarnReferralCode: { type: String, trim: true, sparse: true, index: true },

  // Timestamps
  soldAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Pre-save hook to generate saleId
ticketSaleSchema.pre('save', function(next) {
  if (this.isNew && !this.saleId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9).toUpperCase();
    this.saleId = `SALE-${timestamp}-${random}`;
  }
  next();
});

// Indexes
ticketSaleSchema.index({ vendorId: 1, soldAt: -1 });
ticketSaleSchema.index({ eventId: 1, soldAt: -1 });
ticketSaleSchema.index({ paymentStatus: 1, paymentMethod: 1 });
ticketSaleSchema.index({ soldBy: 1, soldByType: 1 });
// customerUserId's index is declared on the field (sparse: true); re-declaring
// it here produced a conflicting non-sparse "customerUserId_1" that MongoDB
// rejected silently.
ticketSaleSchema.index({ channel: 1, soldAt: -1 });

export const TicketSale = mongoose.model<ITicketSale>('TicketSale', ticketSaleSchema);
