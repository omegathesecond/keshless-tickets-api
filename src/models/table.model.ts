import mongoose, { Schema } from 'mongoose';
import { ITable } from '@interfaces/table.interface';

const integerCents = {
  validator: Number.isSafeInteger,
  message: '{PATH} must be integer minor units (ZAR cents)',
};

const tableLineSchema = new Schema({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  name: { type: String, required: true, trim: true },
  unitPrice: { type: Number, required: true, min: 0, validate: integerCents },
  qty: { type: Number, required: true, min: 1, validate: { validator: Number.isInteger, message: 'qty must be a whole number' } },
  addedBy: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
});

// _id off: merchantId is the key (see ITableFulfilment). Every update
// addresses a row by its stall, so a second identifier would be one more thing
// that can disagree with the first.
const tableFulfilmentSchema = new Schema({
  merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
  status: { type: String, enum: ['paid', 'handed_out', 'collected'], default: 'paid', required: true },
  handedOutAt: { type: Date },
  handedOutBy: { type: String, trim: true },
  acceptedAt: { type: Date },
  acceptedBy: { type: String, trim: true },
}, { _id: false });

const tableSchema = new Schema<ITable>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  label: { type: String, required: true, trim: true },
  status: { type: String, enum: ['open', 'settled', 'voided'], default: 'open', required: true, index: true },
  openedBy: { type: String, required: true },
  items: { type: [tableLineSchema], default: [] },
  subtotal: { type: Number, default: 0, min: 0, validate: integerCents },
  // Optimistic-concurrency token for settlement — see ITable.revision.
  revision: { type: Number, default: 0 },
  fulfilment: { type: [tableFulfilmentSchema], default: [] },
  settledAt: { type: Date },
  settledBy: { type: String },
  walletId: { type: Schema.Types.ObjectId, ref: 'Wallet' },
  // Looked up, not constrained: uniqueness for a settling request is already
  // enforced per-stall by MerchantCharge's {merchantId, clientTxnId} index. This
  // field only needs to be found again so a retried settle can be told apart
  // from a genuine second attempt — see ITable.settleTxnId for the reasoning.
  settleTxnId: { type: String, trim: true, index: true },
  voidedAt: { type: Date },
  voidReason: { type: String, trim: true },
  voidedBy: { type: String },
}, { timestamps: true });

// One OPEN table per label per event. PARTIAL so a settled "7" frees the name
// for the next group — the same reasoning as the wallet bandUid index.
tableSchema.index(
  { eventId: 1, label: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);

// The stall's own feed: "tables at this event with a row for MY stall". Every
// merchant-side read is that question, and without this it is a collection
// scan on the busiest screen of the night.
tableSchema.index({ eventId: 1, 'fulfilment.merchantId': 1, 'fulfilment.status': 1 });

export const Table = mongoose.model<ITable>('Table', tableSchema);
