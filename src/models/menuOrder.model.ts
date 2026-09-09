import mongoose, { Schema, Document, Types } from 'mongoose';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

export enum MenuOrderFulfillmentStatus {
  NEW = 'new',
  PREPARING = 'preparing',
  READY = 'ready',
  COLLECTED = 'collected',
  CANCELLED = 'cancelled',
}

export interface IMenuOrderItem {
  menuItemId: Types.ObjectId;
  name: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

/**
 * A buyer's Menu-tab preorder — the cart/checkout equivalent of TicketSale
 * for food & drink items rather than tickets. `amountCharged` is the subtotal
 * PLUS the Carrot service charge the buyer pays for the convenience of
 * ordering ahead through the platform (see @utils/menuServiceFee.util).
 */
export interface IMenuOrder extends Document {
  _id: Types.ObjectId;
  orderId: string; // MENU-{timestamp}-{random}
  eventId: Types.ObjectId;
  vendorId: Types.ObjectId; // organizer who owns the event (denormalized for querying)
  buyerId: Types.ObjectId;
  buyerName?: string;
  buyerPhone?: string;

  items: IMenuOrderItem[];
  subtotal: number; // sum of lineTotal, face value
  serviceFeeAmount: number; // Carrot convenience charge, on top of subtotal
  amountCharged: number; // subtotal + serviceFeeAmount — what the gateway charges

  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  walletTransactionId?: string; // Keshless transaction ID
  momoReferenceId?: string; // MTN MoMo X-Reference-Id for async collections
  momoFailureReason?: string;

  // Organizer-facing preparation lifecycle — independent of payment status.
  fulfillmentStatus: MenuOrderFulfillmentStatus;
  notes?: string;

  paidAt?: Date;
  // Set the moment a vendor scans the order's QR (orderId) and confirms
  // collection — i.e. when fulfillmentStatus transitions to COLLECTED. Lets a
  // re-scan of an already-redeemed code report "Order already collected at …"
  // instead of just refusing the transition with no timestamp.
  collectedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const menuOrderItemSchema = new Schema<IMenuOrderItem>(
  {
    menuItemId: { type: Schema.Types.ObjectId, ref: 'MenuItem', required: true },
    name: { type: String, required: true },
    unitPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const menuOrderSchema = new Schema<IMenuOrder>(
  {
    orderId: { type: String, required: true, unique: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    buyerName: { type: String, trim: true },
    buyerPhone: { type: String, trim: true },

    items: {
      type: [menuOrderItemSchema],
      required: true,
      validate: { validator: (v: unknown[]) => Array.isArray(v) && v.length > 0, message: 'order must have at least one item' },
    },
    subtotal: { type: Number, required: true, min: 0 },
    serviceFeeAmount: { type: Number, required: true, min: 0, default: 0 },
    amountCharged: { type: Number, required: true, min: 0 },

    paymentMethod: { type: String, enum: Object.values(PaymentMethod), required: true },
    paymentStatus: { type: String, enum: Object.values(PaymentStatus), required: true, default: PaymentStatus.PENDING },
    walletTransactionId: { type: String },
    momoReferenceId: { type: String, sparse: true, unique: true },
    momoFailureReason: { type: String },

    fulfillmentStatus: { type: String, enum: Object.values(MenuOrderFulfillmentStatus), default: MenuOrderFulfillmentStatus.NEW },
    notes: { type: String, trim: true, maxlength: 500 },

    paidAt: { type: Date },
    collectedAt: { type: Date },
  },
  { timestamps: true },
);

menuOrderSchema.index({ eventId: 1, createdAt: -1 });
menuOrderSchema.index({ buyerId: 1, createdAt: -1 });

export const MenuOrder = mongoose.model<IMenuOrder>('MenuOrder', menuOrderSchema);

/**
 * The organizer's preparation lifecycle only moves forward:
 * new → preparing → ready → collected. Any non-terminal state may be
 * cancelled; collected and cancelled are terminal.
 */
export const FULFILLMENT_TRANSITIONS: Readonly<Record<MenuOrderFulfillmentStatus, readonly MenuOrderFulfillmentStatus[]>> = {
  [MenuOrderFulfillmentStatus.NEW]: [MenuOrderFulfillmentStatus.PREPARING, MenuOrderFulfillmentStatus.CANCELLED],
  [MenuOrderFulfillmentStatus.PREPARING]: [MenuOrderFulfillmentStatus.READY, MenuOrderFulfillmentStatus.CANCELLED],
  [MenuOrderFulfillmentStatus.READY]: [MenuOrderFulfillmentStatus.COLLECTED, MenuOrderFulfillmentStatus.CANCELLED],
  [MenuOrderFulfillmentStatus.COLLECTED]: [],
  [MenuOrderFulfillmentStatus.CANCELLED]: [],
};

/**
 * Why `order` may not move to `next` — null when the move is allowed. Kitchen
 * states (anything but cancelled) also require the order to be PAID: an unpaid
 * preorder is not yet an order the bar should be making.
 */
export function fulfillmentTransitionRefusal(
  order: Pick<IMenuOrder, 'fulfillmentStatus' | 'paymentStatus'>,
  next: MenuOrderFulfillmentStatus,
): string | null {
  const current = order.fulfillmentStatus;
  const allowed = FULFILLMENT_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    return allowed.length === 0
      ? `Order is already ${current} and cannot be changed`
      : `Order is ${current}; it cannot move to ${next}`;
  }
  if (next !== MenuOrderFulfillmentStatus.CANCELLED && order.paymentStatus !== PaymentStatus.COMPLETED) {
    return `Order payment is ${order.paymentStatus}; only a paid order can be marked ${next}`;
  }
  return null;
}
