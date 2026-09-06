import mongoose from 'mongoose';
import { Table } from '@models/table.model';
import {
  ITable, ITableLine, TableStatus, ITableFulfilment, TableFulfilmentStatus,
} from '@interfaces/table.interface';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { Wallet, IWallet } from '@models/wallet.model';
import { MerchantCharge, IMerchantCharge } from '@models/merchantCharge.model';
import { StockService } from '@services/stock.service';
import { StockMovementReason } from '@interfaces/stock.interface';
import { LedgerService, Posting } from '@services/ledger.service';
import { LedgerAccountType } from '@interfaces/ledger.interface';
import { WalletDeclinedError } from '@services/merchant.service';
import { normalizeBandUid } from '@utils/bandUid.util';

/** Thrown when a label is already open at this event — the caller maps it to 409. */
export class TableLabelTakenError extends Error {
  constructor(label: string) { super(`Table ${label} is already open`); }
}

/** Cents as a human reads them off the handheld, e.g. 1500 -> "15.00". */
function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * The tag cannot cover the tab. NOTHING was written — no wallet debit, no
 * postings, no charge rows, and the table is still open — so the waiter can
 * top the tag up and tap again.
 *
 * The message names the amount SHORT on purpose: "declined" alone sends the
 * waiter back to the table with nothing to tell the guest, and the guest with
 * no idea how much to add at the desk. Mapped to 402.
 *
 * The message deliberately carries NO currency symbol. This service prices
 * everything in integer cents of whatever currency the EVENT declares — it
 * has no `currency` field in scope here to name correctly, and Carrot events
 * are not all the same currency (Emalangeni by default, Rand for some — see
 * pos-app/lib/pages/cashless/money.dart's currencySymbol()). Hardcoding one
 * symbol was worse than showing none: an operator misreads the shortfall as
 * the wrong money entirely. `short`/`total`/`balance` below carry the actual
 * integer cents so the POS can format them with the event's own currency.
 */
export class TableShortfallError extends Error {
  /** Cents still needed. */
  public readonly short: number;
  constructor(public readonly total: number, public readonly balance: number) {
    super(`Tag is ${formatCents(total - balance)} short — the tab is ${formatCents(total)}, the tag holds ${formatCents(balance)}`);
    this.name = 'TableShortfallError';
    this.short = total - balance;
  }
}

/**
 * The table has already moved past settling. Distinct from a RETRY of the
 * settle that closed it (same clientTxnId), which replays the original
 * charges instead — see TableService.settle. Mapped to 409.
 */
export class TableAlreadySettledError extends Error {
  constructor(public readonly status: TableStatus) {
    super(status === 'settled' ? 'table is already settled' : `table is not open (status: ${status})`);
    this.name = 'TableAlreadySettledError';
  }
}

/**
 * The tapped tag carries no wallet at this event — an unregistered or
 * unbound band. Not a decline (there is no account to decline): the waiter
 * needs to send the guest to the desk to have the tag issued. Mapped to 404.
 */
export class TableWalletNotFoundError extends Error {
  constructor(public readonly bandUid: string) {
    super('no wallet on that tag at this event');
    this.name = 'TableWalletNotFoundError';
  }
}

/**
 * The table changed between pricing it and charging for it — another waiter
 * added or removed a line in that window. RETRYABLE, and nothing was written:
 * the alternative is charging the guest a stale total, leaving the stall that
 * poured the last round unpaid while its stock has already gone. Two waiters
 * on one table is the normal case for table service. Mapped to 409.
 */
export class TableChangedDuringSettlementError extends Error {
  constructor() {
    super('the table changed during settlement — check the tab and try again');
    this.name = 'TableChangedDuringSettlementError';
  }
}

/**
 * A repeat of `clientTxnId` that names a DIFFERENT tag than the one actually
 * charged. Not a retry — a reused id, and replaying success would tell the
 * waiter THIS guest paid when the money came off someone else's band. Mapped
 * to 409. Mirrors MerchantService's ChargeIdempotencyMismatchError.
 */
export class TableIdempotencyMismatchError extends Error {
  public readonly reason = 'idempotency_mismatch' as const;
  constructor(public readonly clientTxnId: string) {
    super('that settlement id was already used for a different tag');
    this.name = 'TableIdempotencyMismatchError';
  }
}

/**
 * Thrown INSIDE the settle transaction when the status guard misses because
 * THIS settle already committed (the POS retried, or a duplicate request
 * overlapped). Throwing aborts the transaction, so nothing this attempt wrote
 * survives, and the outer catch answers with the committed outcome. Never
 * leaves TableService — mirrors MerchantService's ReplayedCharge.
 */
class ReplayedSettlement extends Error {
  constructor(public readonly table: ITable) {
    super('replayed settlement');
    this.name = 'ReplayedSettlement';
  }
}

/**
 * This stall has no handover on this table — it has nothing on the tab, the
 * table does not exist at this event, or the tab was never settled (rows are
 * written by settlement, so an open table has none). Mapped to 404.
 *
 * Deliberately the SAME refusal for all three: a stall operator must not be
 * able to probe which table ids exist at an event, or which of them another
 * stall is serving, by reading the difference between the messages.
 */
export class TableFulfilmentNotFoundError extends Error {
  constructor() {
    super('no handover for this stall on that table');
    this.name = 'TableFulfilmentNotFoundError';
  }
}

/**
 * The handover is real but not where the caller thought: accepting stock the
 * stall has not released, or releasing (or accepting) twice. Mapped to 409.
 *
 * Named separately from the not-found case because the operator's next move
 * differs — one means "check what you tapped", the other means "somebody
 * already did this". The message carries the actual status so a screen that
 * has gone stale can just re-render.
 */
export class TableFulfilmentStateError extends Error {
  constructor(public readonly status: TableFulfilmentStatus, expected: TableFulfilmentStatus) {
    super(`that handover is ${status}, not ${expected}`);
    this.name = 'TableFulfilmentStateError';
  }
}

/** What one stall is owed off a table, and the lines it is owed for. */
interface StallShare {
  merchantId: string;
  lines: ITableLine[];
  /** What the guest is charged for this stall's lines, cents. */
  gross: number;
  /** Platform commission at THIS stall's rate, cents. */
  fee: number;
  /** gross - fee: what the stall is owed, cents. */
  net: number;
}

/** The outcome of settling a table: the closed table, one charge per paid stall, and the tag's remaining balance. */
export interface TableSettlement {
  table: ITable;
  charges: IMerchantCharge[];
  walletBalance: number;
}

/**
 * One table as ONE stall may see it: its own lines, its own money, its own
 * handover row. Not an ITable — the redaction is the point, and returning the
 * real shape would invite a caller to treat it as the whole table.
 */
export interface StallTableView {
  _id: string;
  label: string;
  status: TableStatus;
  items: ITableLine[];
  /** This stall's lines only — NOT what the guest paid for the whole tab. */
  subtotal: number;
  fulfilment: ITableFulfilment;
  settledAt?: Date;
  createdAt: Date;
}

/**
 * The waiter's New/Paid/Collected view, as a query fragment.
 *
 * Derived rather than stored, so a tab can never drift out of step with the
 * rows it summarises. Collected is expressed as "no row is still outstanding"
 * instead of "every row is collected" because Mongo has no all-elements-match
 * operator — and the negative form gives the right answer for a table settled
 * before fulfilment was tracked, which has no rows and nothing outstanding.
 */
function tabFilter(tab?: string): Record<string, unknown> {
  switch (tab) {
    case 'new':
      return { status: 'open' };
    case 'paid':
      return { status: 'settled', fulfilment: { $elemMatch: { status: { $ne: 'collected' } } } };
    case 'collected':
      return { status: 'settled', fulfilment: { $not: { $elemMatch: { status: { $ne: 'collected' } } } } };
    default:
      return {};
  }
}

/**
 * Substring search over the label, which is where both "table 12" and "table
 * Mza" live — one field answers "search table / name" because labels already
 * carry both.
 *
 * Escaped before it becomes a regex: an unescaped label containing `.` or `(`
 * would either match everything or throw, and a search box is the one place a
 * user's raw text reaches a query builder.
 */
function labelFilter(q?: string): Record<string, unknown> {
  const term = (q ?? '').trim();
  if (!term) return {};
  return { label: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
}

/**
 * Move ONE stall's handover from one status to the next, atomically.
 *
 * The expected `from` status is in the FILTER, not checked and then written:
 * two operators tapping Hand out together must produce one transition and one
 * refusal, not two writes racing over the same stamp.
 *
 * A miss is then diagnosed with a second read, because "no such row" and "the
 * row has already moved" send the operator to different places — and only the
 * second is worth telling them the current status of.
 */
async function advanceFulfilment(params: {
  tableId: string; eventId: string; merchantId: string;
  from: TableFulfilmentStatus; to: TableFulfilmentStatus;
  stamp: Record<string, unknown>;
}): Promise<ITable> {
  const { tableId, eventId, merchantId, from, to, stamp } = params;
  const tableObjId = new mongoose.Types.ObjectId(tableId);
  const eventObjId = new mongoose.Types.ObjectId(eventId);
  const merchantObjId = new mongoose.Types.ObjectId(merchantId);

  const set: Record<string, unknown> = { 'fulfilment.$[row].status': to };
  for (const [k, v] of Object.entries(stamp)) set[`fulfilment.$[row].${k}`] = v;

  const updated = await Table.findOneAndUpdate(
    {
      _id: tableObjId, eventId: eventObjId, status: 'settled',
      fulfilment: { $elemMatch: { merchantId: merchantObjId, status: from } },
    },
    { $set: set },
    {
      new: true,
      arrayFilters: [{ 'row.merchantId': merchantObjId, 'row.status': from }],
    },
  );
  if (updated) return updated;

  // eventId stays in this lookup too: a table at another event must read
  // exactly like a missing one, or the error itself confirms it exists.
  const current = await Table.findOne({ _id: tableObjId, eventId: eventObjId });
  const row = current?.fulfilment.find((f) => String(f.merchantId) === merchantId);
  if (!row) throw new TableFulfilmentNotFoundError();
  throw new TableFulfilmentStateError(row.status, from);
}

export class TableService {
  static async open(params: { eventId: string; label: string; openedBy: string }): Promise<ITable> {
    const label = params.label.trim();
    if (!label) throw new Error('label is required');
    try {
      return await Table.create({
        eventId: new mongoose.Types.ObjectId(params.eventId),
        label, status: 'open', openedBy: params.openedBy, items: [], subtotal: 0,
      });
    } catch (err) {
      // The partial unique index is the arbiter, so two waiters opening "7" at
      // once cannot both win. Discriminated by keyPattern so an E11000 from any
      // other index is not mislabelled.
      if ((err as { keyPattern?: Record<string, unknown> })?.keyPattern?.label) {
        throw new TableLabelTakenError(label);
      }
      throw err;
    }
  }

  /**
   * The floor's table list.
   *
   * `status` selects the raw table status; `tab` selects the waiter's
   * New/Paid/Collected view, which is a PROJECTION over status plus the
   * fulfilment rows rather than a stored field — see tabFilter. They are
   * different questions, so both are offered rather than one overloaded.
   */
  static async list(
    eventId: string,
    opts: { status?: string; tab?: string; q?: string } = {},
  ): Promise<ITable[]> {
    const { status, tab, q } = opts;
    return Table.find({
      eventId: new mongoose.Types.ObjectId(eventId),
      ...(status ? { status } : {}),
      ...tabFilter(tab),
      ...labelFilter(q),
    }).sort({ createdAt: -1 }).limit(200);
  }

  /**
   * The tables one STALL is serving, carrying only that stall's own lines.
   *
   * A stall must never learn what another stall poured or what the guest paid
   * overall, so `items` is filtered to the caller's own merchantId and the
   * subtotal recomputed from that subset — the whole-tab `subtotal` on the
   * stored document would be a leak. Returned as plain objects, not
   * documents: these are a projection, and handing back something that looks
   * saveable invites a caller to save the redacted version over the real one.
   */
  static async listForStall(params: {
    eventId: string; merchantId: string; status?: TableFulfilmentStatus;
  }): Promise<StallTableView[]> {
    const { eventId, merchantId, status } = params;
    const merchantObjId = new mongoose.Types.ObjectId(merchantId);

    const tables = await Table.find({
      eventId: new mongoose.Types.ObjectId(eventId),
      // $elemMatch, not dotted paths: {'fulfilment.merchantId': x,
      // 'fulfilment.status': y} matches a table where SOME row names the
      // stall and SOME (possibly other) row has the status — so the Bar would
      // see a table the moment the Kitchen handed food over.
      fulfilment: { $elemMatch: { merchantId: merchantObjId, ...(status ? { status } : {}) } },
    }).sort({ settledAt: -1, createdAt: -1 }).limit(200).lean<ITable[]>();

    return tables.map((t) => {
      const mine = t.items.filter((i) => String(i.merchantId) === merchantId);
      const row = t.fulfilment.find((f) => String(f.merchantId) === merchantId)!;
      return {
        _id: String(t._id),
        label: t.label,
        status: t.status,
        items: mine,
        subtotal: mine.reduce((s, i) => s + i.unitPrice * i.qty, 0),
        fulfilment: row,
        settledAt: t.settledAt,
        createdAt: t.createdAt,
      };
    });
  }

  /**
   * The stall's half of the handshake: the stock has left the counter.
   *
   * Guarded on the row being exactly 'paid', so a double-tap is refused
   * rather than re-stamping handedOutBy with whoever tapped last — the point
   * of the stamp is that it names the person who actually released it.
   */
  static async handOut(params: {
    tableId: string; eventId: string; merchantId: string; handedOutBy: string;
  }): Promise<ITable> {
    return advanceFulfilment({
      ...params,
      from: 'paid', to: 'handed_out',
      stamp: { handedOutAt: new Date(), handedOutBy: params.handedOutBy },
    });
  }

  /**
   * The waiter's half: the stock is in their hands.
   *
   * Guarded on 'handed_out', so a waiter cannot mark collected something the
   * stall never released. Leaves the stall's own stamp untouched — a disputed
   * handover is only worth anything with both halves on it.
   */
  static async accept(params: {
    tableId: string; eventId: string; merchantId: string; acceptedBy: string;
  }): Promise<ITable> {
    return advanceFulfilment({
      ...params,
      from: 'handed_out', to: 'collected',
      stamp: { acceptedAt: new Date(), acceptedBy: params.acceptedBy },
    });
  }

  /**
   * Add one product line from a stall onto an open table, moving that
   * stall's stock in the same beat. name/unitPrice are SNAPSHOTTED from the
   * catalogue right now — a later price change at the stall must never
   * reprice a drink already drunk (ITableLine's documented invariant).
   */
  static async addItem(params: {
    tableId: string; eventId: string; merchantId: string; productId: string; qty: number; addedBy: string;
  }): Promise<ITable> {
    const { tableId, eventId, merchantId, productId, qty, addedBy } = params;
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('qty must be a positive whole number');

    const eventObjId = new mongoose.Types.ObjectId(eventId);
    const merchantObjId = new mongoose.Types.ObjectId(merchantId);
    const productObjId = new mongoose.Types.ObjectId(productId);
    const tableObjId = new mongoose.Types.ObjectId(tableId);

    // Resolved BEFORE the transaction, same reasoning as MerchantService.charge
    // resolving its item snapshots up front: prices are stable between here and
    // commit, so only the table push + the stock CAS below need to be atomic.
    const merchant = await Merchant.findOne({ _id: merchantObjId, eventId: eventObjId });
    if (!merchant) throw new Error('stall not found for this event');
    // Deliberately its OWN refusal, not folded into the findOne filter above:
    // "no such stall at this event" and "this stall exists but is closed" are
    // different problems for the waiter holding the handheld — one means
    // check what you tapped, the other means walk to the desk. Design doc's
    // failure-modes section: suspension blocks NEW items, not money already
    // owed — TableService.settle deliberately still pays a stall suspended
    // after its drinks were served (see tableSettle.test.ts), so this check
    // must never move into settle.
    if (merchant.status !== 'active') throw new Error('stall is closed — suspended stalls cannot take new orders');
    const product = await Product.findOne({ _id: productObjId, eventId: eventObjId, active: true });
    if (!product) throw new Error('product not found for this event');
    // A ProductStock row is what makes a product "sold at" a stall — the same
    // relationship StockService.applyMovement's own CAS depends on. No row
    // means this stall never stocked the product, whatever event it belongs to.
    const stockRow = await ProductStock.findOne({ merchantId: merchantObjId, productId: productObjId });
    if (!stockRow) throw new Error('product not sold at that stall');

    const line = {
      merchantId: merchantObjId, productId: productObjId,
      name: product.name, unitPrice: product.price, qty, addedBy, addedAt: new Date(),
    };
    const lineTotal = product.price * qty;

    const session = await mongoose.startSession();
    try {
      let result!: ITable;
      await session.withTransaction(async () => {
        // Single guarded update: $push the line and $inc the subtotal in the
        // SAME atomic op, with status:'open' in the FILTER — a read-modify-save
        // here would let two concurrent adds both read the same items array
        // and one clobber the other's push.
        const updated = await Table.findOneAndUpdate(
          { _id: tableObjId, eventId: eventObjId, status: 'open' },
          // revision rides along in the SAME $inc: a separate write could land
          // without the push (or vice versa) and the token would lie.
          { $push: { items: line }, $inc: { subtotal: lineTotal, revision: 1 } },
          { new: true, session },
        );
        if (!updated) {
          const existing = await Table.findOne({ _id: tableObjId, eventId: eventObjId }).session(session);
          if (!existing) throw new Error('table not found');
          throw new Error(`table is not open (status: ${existing.status})`);
        }

        // Stock leaves the shelf when the waiter takes it, not when the tab is
        // settled — written in the SAME transaction as the table push, so a
        // decline here (out of stock) rolls the push back too.
        await StockService.applyMovement({
          eventId: eventObjId, merchantId: merchantObjId, productId: productObjId,
          delta: -qty, reason: StockMovementReason.SALE, refType: 'table', refId: tableId,
          // A waiter is neither the stall's own till ('Merchant') nor the
          // organizer's own admin action ('Organizer') — attributing their
          // movement to either would misreport who actually took the stock.
          byType: 'Waiter', by: addedBy, session,
        });

        result = updated;
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Remove a mis-punched line. This is the "never left the counter" case —
   * the bottle goes back on the shelf, so the stall's stock must go back up.
   * Line-pull + subtotal-decrement + stock-return all happen in ONE
   * transaction, same idiom as addItem: a stock return that lands while the
   * line removal fails would credit the stall with a bottle it still doesn't
   * have back.
   */
  static async removeItem(params: { tableId: string; eventId: string; lineId: string; removedBy: string }): Promise<ITable> {
    const { tableId, eventId, lineId, removedBy } = params;
    const tableObjId = new mongoose.Types.ObjectId(tableId);
    const eventObjId = new mongoose.Types.ObjectId(eventId);
    const lineObjId = new mongoose.Types.ObjectId(lineId);

    // Resolved BEFORE the transaction, same reasoning as addItem's merchant/
    // product lookups: a line's merchantId/productId/unitPrice/qty are a
    // snapshot nothing else can mutate — only removal ever touches it — so
    // reading it up front races with nothing. eventId is in THIS filter too —
    // a table belonging to another event must read exactly like a missing
    // one, not surface a distinct "wrong event" error that would confirm to
    // a waiter at event A that some id exists at event B.
    const table = await Table.findOne({ _id: tableObjId, eventId: eventObjId });
    if (!table) throw new Error('table not found');
    const line = table.items.find((i) => String(i._id) === lineId);
    if (!line) throw new Error('line not found on this table');
    if (table.status !== 'open') throw new Error(`table is not open (status: ${table.status})`);
    const lineTotal = line.unitPrice * line.qty;

    const session = await mongoose.startSession();
    try {
      let result!: ITable;
      await session.withTransaction(async () => {
        // Single guarded update: $pull the line and $inc the subtotal down in
        // the SAME atomic op, with status:'open', eventId, AND the line's own
        // _id in the FILTER — so a concurrent settle/void, a concurrent
        // removal of the same line, or (as above) a cross-event id simply
        // fails to match rather than double-applying or leaking existence.
        const updated = await Table.findOneAndUpdate(
          { _id: tableObjId, eventId: eventObjId, status: 'open', 'items._id': lineObjId },
          // revision rides along in the SAME $inc, as in addItem.
          { $pull: { items: { _id: lineObjId } }, $inc: { subtotal: -lineTotal, revision: 1 } },
          { new: true, session },
        );
        if (!updated) {
          const existing = await Table.findOne({ _id: tableObjId, eventId: eventObjId }).session(session);
          if (!existing) throw new Error('table not found');
          if (existing.status !== 'open') throw new Error(`table is not open (status: ${existing.status})`);
          throw new Error('line not found on this table');
        }

        // The compensating movement is its OWN event (MANUAL, not a smaller
        // SALE) so the stock history can be read backwards: "this bottle came
        // back because a line was removed", not silently absorbed into the sale.
        await StockService.applyMovement({
          eventId: table.eventId, merchantId: line.merchantId, productId: line.productId,
          delta: line.qty, reason: StockMovementReason.MANUAL,
          refType: 'table_line_removed', refId: lineId,
          byType: 'Waiter', by: removedBy, session,
        });

        result = updated;
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Close an unpaid table WITHOUT returning stock. The drinks were consumed
   * or the table walked out — that loss is real, and voidReason/voidedBy is
   * the venue's record of it. Returning stock here would let a walked table
   * look, on the shelf, exactly like a table that never happened. No
   * transaction needed: unlike addItem/removeItem this touches only the
   * table document, nothing in ProductStock.
   */
  static async voidTable(params: { tableId: string; eventId: string; reason: string; voidedBy: string }): Promise<ITable> {
    const { tableId, eventId, voidedBy } = params;
    const reason = params.reason.trim();
    if (!reason) throw new Error('reason is required');
    const eventObjId = new mongoose.Types.ObjectId(eventId);

    // eventId lives in BOTH the guarded update's filter and the fallback
    // lookup below — same reasoning as removeItem: a table belonging to
    // another event must be indistinguishable from a missing one, in every
    // branch, or the error message itself becomes the leak.
    const updated = await Table.findOneAndUpdate(
      { _id: new mongoose.Types.ObjectId(tableId), eventId: eventObjId, status: 'open' },
      { $set: { status: 'voided', voidedAt: new Date(), voidReason: reason, voidedBy } },
      { new: true },
    );
    if (!updated) {
      const existing = await Table.findOne({ _id: tableId, eventId: eventObjId });
      if (!existing) throw new Error('table not found');
      throw new Error(`table is not open (status: ${existing.status})`);
    }
    return updated;
  }

  /**
   * Settle a whole table against ONE tapped tag.
   *
   * A table holds lines from SEVERAL stalls, each with its own commission and
   * its own MERCHANT ledger account, so the money cannot move as one lump —
   * but the guest taps once, so it must still be all-or-nothing. The
   * resolution is a single balanced journal entry that fans out:
   *
   *   WALLET   ref=wallet   +total
   *   MERCHANT ref=stallA   -netA        FEES  -feeA
   *   MERCHANT ref=stallB   -netB        FEES  -feeB
   *
   * posted with the table flip, the wallet debit and every MerchantCharge in
   * ONE transaction. The postings sum to zero by construction, not by luck:
   * `total` is the sum of the same per-stall `gross` figures each stall's
   * `net + fee` is split out of, so no rounding rule can unbalance it.
   *
   * Idempotent on `clientTxnId`: a POS that loses its network after the charge
   * lands will retry, and telling that waiter it failed while the guest HAS
   * been charged is worse than any other outcome here. A retry replays the
   * committed charges; a settle under a DIFFERENT id on an already-settled
   * table is refused.
   */
  static async settle(params: {
    tableId: string; eventId: string; bandUid: string;
    /** The waiter (a Waiter _id) taking the money — attribution on every charge row. */
    settledBy: string;
    /** Their name, snapshotted so the record survives a rename. */
    staffName: string;
    clientTxnId: string;
  }): Promise<TableSettlement> {
    const { tableId, eventId, settledBy, staffName, clientTxnId } = params;
    if (!clientTxnId?.trim()) throw new Error('clientTxnId is required');
    if (!staffName?.trim()) throw new Error('staffName is required');

    const tableObjId = new mongoose.Types.ObjectId(tableId);
    const eventObjId = new mongoose.Types.ObjectId(eventId);
    const bandUid = normalizeBandUid(params.bandUid);

    // eventId is in the filter, as everywhere else in this service: a table at
    // another event must read exactly like a missing one.
    const table = await Table.findOne({ _id: tableObjId, eventId: eventObjId });
    if (!table) throw new Error('table not found');
    if (table.status !== 'open') {
      // The ordinary retry path: the first settle committed, the POS resent it.
      const replay = await TableService.replaySettlement(table, clientTxnId, bandUid, eventObjId);
      if (replay) return replay;
      throw new TableAlreadySettledError(table.status);
    }
    if (!table.items.length) throw new Error('there is nothing on this table');

    const stalls = await TableService.shareOutByStall(table, eventObjId);
    const total = stalls.reduce((t, s) => t + s.gross, 0);
    // Every line comped to zero. There is no money to move and no charge row
    // that would validate (MerchantCharge floors at 1 cent), so this is not a
    // settle — the waiter voids it.
    if (total <= 0) throw new Error('there is nothing on this table to charge for');

    const wallet = await Wallet.findOne({ eventId: eventObjId, bandUid });
    if (!wallet) throw new TableWalletNotFoundError(bandUid);
    // Checked BEFORE the transaction so a short tag is answered with the
    // amount short and nothing is written. The wallet CAS inside the
    // transaction is still the authoritative guard against a concurrent spend.
    if (wallet.balance < total) throw new TableShortfallError(total, wallet.balance);

    const postings: Posting[] = [
      { account: { type: LedgerAccountType.WALLET, ref: String(wallet._id) }, delta: total },
      ...stalls.flatMap((s): Posting[] => [
        { account: { type: LedgerAccountType.MERCHANT, ref: s.merchantId }, delta: -s.net },
        ...(s.fee > 0 ? [{ account: { type: LedgerAccountType.FEES }, delta: -s.fee }] : []),
      ]),
    ];

    const session = await mongoose.startSession();
    try {
      let out!: TableSettlement;
      await session.withTransaction(async () => {
        // The status guard is what stops two simultaneous settles from both
        // charging the guest: exactly one findOneAndUpdate can move the table
        // off 'open'. settleTxnId goes down in the SAME $set, so the loser can
        // tell "I already did this" (retry -> replay) from "somebody else did"
        // (different id -> refuse).
        //
        // revision + subtotal + item count are in the filter, because the lines
        // were read and priced OUTSIDE this transaction. A colleague's addItem
        // or removeItem committing in that window would otherwise be silently
        // charged over: the guest pays a stale total, the stall that poured the
        // last round is never paid though its stock has gone, and the table's
        // subtotal ends up disagreeing with the charges written against it.
        //
        // revision is the load-bearing one — every line change bumps it, so it
        // catches the case the money figures cannot: a line removed at one
        // stall and an identically-priced one added at ANOTHER leaves subtotal
        // AND the count untouched while the split between merchants moves.
        // subtotal and the count stay as independent belt-and-braces. A miss
        // is "the table moved under me": refuse the whole settle, never part.
        const settled = await Table.findOneAndUpdate(
          {
            _id: tableObjId, eventId: eventObjId, status: 'open',
            revision: table.revision,
            subtotal: table.subtotal, items: { $size: table.items.length },
          },
          {
            $set: {
              status: 'settled', settledAt: new Date(), settledBy,
              walletId: wallet._id, settleTxnId: clientTxnId,
              // The handover opens here, from the SAME per-stall split that
              // prices the charges below — so the stalls owed money and the
              // stalls owing stock are the same list by construction, and
              // land in the same transaction as the money. Written whole
              // rather than appended: the guard above has already proved this
              // table is 'open', which is the only state with no rows.
              fulfilment: stalls.map((s) => ({ merchantId: s.merchantId, status: 'paid' })),
            },
          },
          { new: true, session },
        );
        if (!settled) {
          const current = await Table.findOne({ _id: tableObjId, eventId: eventObjId }).session(session);
          if (!current) throw new Error('table not found');
          if (current.status === 'settled' && current.settleTxnId === clientTxnId) {
            throw new ReplayedSettlement(current);
          }
          if (current.status !== 'open') throw new TableAlreadySettledError(current.status);
          // Still open, so it was the priced-shape guard that missed.
          throw new TableChangedDuringSettlementError();
        }

        // Atomic CAS debit — the guard and the decrement are ONE operation, so
        // no concurrent tap can push the balance negative. cashFundedBalance is
        // drawn down first and floored at 0, the pattern wallet.model.ts
        // documents and MerchantService.charge follows.
        const debited = await Wallet.findOneAndUpdate(
          { _id: wallet._id, eventId: eventObjId, status: 'active', balance: { $gte: total } },
          [
            {
              $set: {
                balance: { $subtract: ['$balance', total] },
                cashFundedBalance: { $max: [0, { $subtract: ['$cashFundedBalance', total] }] },
              },
            },
          ],
          { new: true, session },
        );
        if (!debited) {
          // Someone spent the tag down (or froze it) between the pre-check and
          // here. Throwing aborts the transaction, so the table flip above
          // rolls back with everything else and the tab stays open.
          const fresh = await Wallet.findOne({ _id: wallet._id, eventId: eventObjId }).session(session);
          if (!fresh) throw new TableWalletNotFoundError(bandUid);
          if (fresh.status !== 'active') {
            throw new WalletDeclinedError('wallet_not_active', 'that tag is not active', fresh.balance);
          }
          throw new TableShortfallError(total, fresh.balance);
        }

        await LedgerService.post({
          eventId, postings, refType: 'table_settlement', refId: tableId, session,
        });

        // One row per stall, each keyed on `${clientTxnId}:${merchantId}` so
        // MerchantCharge's existing {merchantId, clientTxnId} unique index
        // makes a concurrent duplicate an E11000 (a replay) rather than a
        // second bill — and so a stall's takings report reads a table charge
        // exactly like a till charge.
        const charges = await MerchantCharge.create(
          stalls.map((s) => ({
            merchantId: s.merchantId, eventId, walletId: wallet._id, bandUid,
            amount: s.gross, fee: s.fee, netAmount: s.net,
            clientTxnId: `${clientTxnId}:${s.merchantId}`, status: 'completed',
            items: s.lines.map((l) => ({
              productId: l.productId, name: l.name, unitPrice: l.unitPrice,
              qty: l.qty, lineTotal: l.unitPrice * l.qty,
            })),
            // A table has no till operator — the waiter collected from several
            // stalls and settled them together (see IMerchantCharge).
            waiterId: settledBy, staffName,
          })),
          { session },
        );

        out = { table: settled, charges, walletBalance: debited.balance };
      });
      return out;
    } catch (e) {
      if (e instanceof ReplayedSettlement) {
        const replay = await TableService.replaySettlement(e.table, clientTxnId, bandUid, eventObjId);
        if (replay) return replay;
        throw new TableAlreadySettledError(e.table.status);
      }
      // The per-stall unique index lost the race to a concurrent duplicate of
      // THIS settle. Because the id embeds clientTxnId, an E11000 there can
      // only mean the same settle committed elsewhere — answer with it.
      if ((e as { code?: number })?.code === 11000) {
        const current = await Table.findOne({ _id: tableObjId, eventId: eventObjId });
        const replay = current ? await TableService.replaySettlement(current, clientTxnId, bandUid, eventObjId) : null;
        if (replay) return replay;
      }
      throw e;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Split a table's lines by stall and price each share at THAT stall's own
   * commission, read fresh from its Merchant document right now — never
   * cached and never copied onto the table, so a rate change takes effect
   * immediately and one stall's rate can never leak onto another's line.
   *
   * A SUSPENDED stall is deliberately still paid: suspension blocks new items,
   * not money already owed. The drinks went out.
   */
  private static async shareOutByStall(
    table: ITable,
    eventObjId: mongoose.Types.ObjectId,
  ): Promise<StallShare[]> {
    const byStall = new Map<string, ITableLine[]>();
    for (const line of table.items) {
      const key = String(line.merchantId);
      const lines = byStall.get(key);
      if (lines) lines.push(line); else byStall.set(key, [line]);
    }

    const merchants = await Merchant.find({ _id: { $in: [...byStall.keys()] }, eventId: eventObjId });
    const rateOf = new Map(merchants.map((m) => [String(m._id), m.commissionPercent || 0]));

    const shares: StallShare[] = [];
    for (const [merchantId, lines] of byStall) {
      const rate = rateOf.get(merchantId);
      // A line whose stall is gone (or belongs to another event) has no rate
      // to charge at. Guessing one would misallocate real money, so refuse the
      // whole settle rather than pay part of the table.
      if (rate == null) throw new Error('a stall on this table was not found for this event');
      const gross = lines.reduce((t, l) => t + l.unitPrice * l.qty, 0);
      // Floor, matching MerchantService.charge: deterministic, and the platform
      // never rounds a cent it is not owed out of the stall's share. `net` is
      // then a SUBTRACTION from the same gross, which is what keeps
      // net + fee === gross exactly and the journal entry balanced.
      const fee = Math.floor((gross * rate) / 100);
      // A fully comped stall is owed nothing: no charge row (the model floors
      // at 1 cent) and no zero-delta ledger legs. Not a silent drop — there is
      // no money to move.
      if (gross <= 0) continue;
      shares.push({ merchantId, lines, gross, fee, net: gross - fee });
    }
    return shares;
  }

  /**
   * The outcome of the settle that ALREADY closed this table, when the caller
   * is retrying it — or null when this is a genuinely different request and
   * must be refused instead.
   */
  private static async replaySettlement(
    table: ITable,
    clientTxnId: string,
    bandUid: string,
    eventObjId: mongoose.Types.ObjectId,
  ): Promise<TableSettlement | null> {
    if (table.status !== 'settled' || table.settleTxnId !== clientTxnId) return null;

    // A settled table always names the wallet it was charged to. Missing means
    // the row was tampered with, and reporting a balance we cannot read would
    // be a lie — fail loudly instead.
    const wallet: IWallet | null = table.walletId ? await Wallet.findById(table.walletId) : null;
    if (!wallet) throw new Error('settled table has no wallet on record');

    // Only a repeat of the SAME tap is a replay, the rule MerchantService.replay
    // applies to a basket. A retry that names a different band under the same id
    // would otherwise be answered "paid" while the money came off the FIRST
    // guest's tag — the second guest walks having paid nothing.
    if (wallet.bandUid !== bandUid) throw new TableIdempotencyMismatchError(clientTxnId);

    const perStallIds = [...new Set(table.items.map((l) => String(l.merchantId)))]
      .map((merchantId) => `${clientTxnId}:${merchantId}`);
    // eventId scopes the lookup. clientTxnId is client-chosen and the
    // {merchantId, clientTxnId} index is unique only per MERCHANT, so nothing
    // about the id alone guarantees the rows it matches are this table's —
    // and handing back another table's charges as this table's replay is the
    // worst possible answer. Today a Merchant belongs to exactly one event, so
    // the merchantId embedded in the id already implies the event; this filter
    // is what keeps that true if a stall is ever allowed to span events.
    const charges = await MerchantCharge.find({ eventId: eventObjId, clientTxnId: { $in: perStallIds } });

    return { table, charges, walletBalance: wallet.balance };
  }
}
