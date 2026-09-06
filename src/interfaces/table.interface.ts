import { Document, Types } from 'mongoose';

export type TableStatus = 'open' | 'settled' | 'voided';

/**
 * How far one STALL has got with handing its share of a table over.
 *
 * Separate from TableStatus because they answer different questions. A table
 * is settled once, for the whole tab; a handover happens per counter, and a
 * table with drinks and food is two of them. Collapsing the two would let the
 * Bar close out food it never touched.
 */
export type TableFulfilmentStatus = 'paid' | 'handed_out' | 'collected';

/**
 * One stall's handover on one table.
 *
 * Written by settlement — one row per stall on the tab, at 'paid' — and
 * advanced by the two halves of the handshake: the stall releases the stock,
 * the waiter accepts it. Both are required. Either alone would leave a
 * disputed handover with one person's word on it; together they leave two
 * timestamps and two actor ids.
 *
 * No `_id`: merchantId is the natural key. A table cannot have two rows for
 * one stall, and every update addresses a row by the stall it belongs to.
 */
export interface ITableFulfilment {
  merchantId: Types.ObjectId;
  status: TableFulfilmentStatus;
  /** When the stall released the stock, and which operator did it. */
  handedOutAt?: Date;
  handedOutBy?: string;
  /** When the waiter confirmed receipt, and which waiter. */
  acceptedAt?: Date;
  acceptedBy?: string;
}

/**
 * One line on a table. Name and unitPrice are SNAPSHOTTED at add time, the way
 * MerchantCharge.items already does: a price change at the stall must never
 * reprice a drink somebody already drank.
 */
export interface ITableLine {
  _id: Types.ObjectId;
  merchantId: Types.ObjectId;
  productId: Types.ObjectId;
  name: string;
  unitPrice: number;
  qty: number;
  addedBy: string;
  addedAt: Date;
}

export interface ITable extends Document {
  eventId: Types.ObjectId;
  label: string;
  status: TableStatus;
  openedBy: string;
  items: ITableLine[];
  subtotal: number;
  /**
   * Bumped by EVERY update that changes the line set. Settlement prices the
   * lines outside its transaction, then names this value in its guarded flip,
   * so any change committed in that window makes the flip miss.
   *
   * subtotal cannot do this job alone: removing a line at one stall and adding
   * one of identical value at ANOTHER leaves subtotal and the line count both
   * unchanged, while the split between merchants has moved. The guest's total
   * would be right and the money would go to the wrong stall.
   */
  revision: number;
  /**
   * One row per stall on the tab, written by settlement. Empty while the
   * table is open, and on any table settled before fulfilment was tracked —
   * which reads as "nothing outstanding", the right answer for both.
   */
  fulfilment: ITableFulfilment[];
  settledAt?: Date;
  settledBy?: string;
  walletId?: Types.ObjectId;
  /**
   * The id of the settling transaction/request that closed this table, set by
   * the (later) settlement task alongside its guarded
   * `findOneAndUpdate({ _id, status: 'open' }, ...)`. That guard is what stops
   * two simultaneous settles from both charging the guest — but a POS that
   * retries after a network timeout resends the SAME request, and the retry
   * must replay the original outcome rather than be refused as "already
   * settled". Storing the id here is what lets settlement tell a retry (same
   * id: replay the existing charges) apart from a genuine second attempt
   * (different id: refuse, already settled). Without it the guard and the
   * replay requirement contradict each other.
   */
  settleTxnId?: string;
  voidedAt?: Date;
  voidReason?: string;
  voidedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}
