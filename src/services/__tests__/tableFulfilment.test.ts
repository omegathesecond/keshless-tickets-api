import mongoose from 'mongoose';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { EVENT, seedStall } from '@/__tests__/helpers/tables';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import {
  TableService, TableFulfilmentNotFoundError, TableFulfilmentStateError,
} from '@services/table.service';
import { WalletService } from '@services/wallet.service';
import { Table } from '@models/table.model';
import { ITable } from '@interfaces/table.interface';

// Settling runs the table flip, the wallet debit, the ledger postings and the
// charge rows in one transaction, so this suite needs a replica set.
beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const WAITER = new mongoose.Types.ObjectId();
const BAR_OP = 'merchant-op-bar';
let labelSeq = 0;

/** A table carrying a line from each of two stalls — drinks and food. */
async function twoStallTable(): Promise<{ table: ITable; bar: string; kitchen: string }> {
  const bar = await seedStall({ price: 3000, onHand: 10, name: 'Beer' });
  const kitchen = await seedStall({ price: 4500, onHand: 10, name: 'Burger' });
  const opened = await Table.create({
    eventId: EVENT, label: `F${labelSeq++}`, status: 'open',
    openedBy: String(WAITER), items: [], subtotal: 0,
  });
  const args = { tableId: String(opened._id), eventId: String(EVENT), qty: 1, addedBy: String(WAITER) };
  await TableService.addItem({ ...args, merchantId: bar.merchantId, productId: bar.productId });
  const table = await TableService.addItem({ ...args, merchantId: kitchen.merchantId, productId: kitchen.productId });
  return { table, bar: bar.merchantId, kitchen: kitchen.merchantId };
}

async function fundedTag(amount: number, bandUid: string) {
  await enrolTags(EVENT, bandUid);
  const { wallet } = await WalletService.ensureStandaloneWalletForBand({ eventId: String(EVENT), bandUid });
  await WalletService.topUpCash({
    walletId: String(wallet._id), eventId: String(EVENT), amount,
    recordedBy: 'fixture-desk', recordedByType: 'Cashier', clientTxnId: `fund-${wallet._id}`,
  });
}

/** Settle a table the way the floor does, and hand back the fresh document. */
async function settle(table: ITable, tag: string, txn: string): Promise<ITable> {
  await fundedTag(50000, tag);
  const { table: settled } = await TableService.settle({
    tableId: String(table._id), eventId: String(EVENT), bandUid: tag,
    settledBy: String(WAITER), staffName: 'Thabo', clientTxnId: txn,
  });
  return settled;
}

const rowFor = (table: ITable, merchantId: string) =>
  table.fulfilment.find((f) => String(f.merchantId) === merchantId);

describe('settlement opens the handover', () => {
  it('writes one row per stall, each at paid', async () => {
    const { table, bar, kitchen } = await twoStallTable();

    const settled = await settle(table, '04a10001', 'f1');

    expect(settled.fulfilment).toHaveLength(2);
    expect(rowFor(settled, bar)!.status).toBe('paid');
    expect(rowFor(settled, kitchen)!.status).toBe('paid');
  });

  it('leaves an open table with no rows — there is nothing to hand over unpaid', async () => {
    const { table } = await twoStallTable();
    expect((await Table.findById(table._id))!.fulfilment).toEqual([]);
  });

  it('opens no handover for a stall with nothing on the tab', async () => {
    const { table, bar } = await twoStallTable();
    const uninvolved = await seedStall({ price: 900, onHand: 5, name: 'Water' });

    const settled = await settle(table, '04a10002', 'f2');

    expect(rowFor(settled, bar)).toBeDefined();
    expect(rowFor(settled, uninvolved.merchantId)).toBeUndefined();
  });
});

describe('the stall releases the stock', () => {
  it('moves its own row to handed_out and stamps who did it', async () => {
    const { table, bar, kitchen } = await twoStallTable();
    const settled = await settle(table, '04a10003', 'f3');

    const after = await TableService.handOut({
      tableId: String(settled._id), eventId: String(EVENT), merchantId: bar, handedOutBy: BAR_OP,
    });

    const row = rowFor(after, bar)!;
    expect(row.status).toBe('handed_out');
    expect(row.handedOutBy).toBe(BAR_OP);
    expect(row.handedOutAt).toBeInstanceOf(Date);
    // THE point of per-stall rows: the Bar releasing drinks says nothing
    // about the Kitchen's food.
    expect(rowFor(after, kitchen)!.status).toBe('paid');
  });

  it('refuses a second hand-out, rather than re-stamping the first', async () => {
    const { table, bar } = await twoStallTable();
    const settled = await settle(table, '04a10004', 'f4');
    const args = {
      tableId: String(settled._id), eventId: String(EVENT), merchantId: bar, handedOutBy: BAR_OP,
    };
    await TableService.handOut(args);

    await expect(TableService.handOut({ ...args, handedOutBy: 'someone-else' }))
      .rejects.toThrow(TableFulfilmentStateError);

    const fresh = await Table.findById(settled._id);
    expect(rowFor(fresh!, bar)!.handedOutBy).toBe(BAR_OP);
  });

  it('refuses a stall that has nothing on this table', async () => {
    const { table } = await twoStallTable();
    const settled = await settle(table, '04a10005', 'f5');
    const stranger = await seedStall({ price: 900, onHand: 5, name: 'Water' });

    await expect(TableService.handOut({
      tableId: String(settled._id), eventId: String(EVENT),
      merchantId: stranger.merchantId, handedOutBy: BAR_OP,
    })).rejects.toThrow(TableFulfilmentNotFoundError);
  });

  it('refuses an UNPAID table — stock is not released against an open tab', async () => {
    const { table, bar } = await twoStallTable();

    await expect(TableService.handOut({
      tableId: String(table._id), eventId: String(EVENT), merchantId: bar, handedOutBy: BAR_OP,
    })).rejects.toThrow(TableFulfilmentNotFoundError);
  });
});

describe('the waiter accepts the stock', () => {
  /** A settled table whose Bar row has already been released. */
  async function released() {
    const { table, bar, kitchen } = await twoStallTable();
    const settled = await settle(table, `04a1${labelSeq}${labelSeq}11`, `acc-${labelSeq}`);
    await TableService.handOut({
      tableId: String(settled._id), eventId: String(EVENT), merchantId: bar, handedOutBy: BAR_OP,
    });
    return { tableId: String(settled._id), bar, kitchen };
  }

  it('closes the handshake, stamping the waiter who took it', async () => {
    const { tableId, bar } = await released();

    const after = await TableService.accept({
      tableId, eventId: String(EVENT), merchantId: bar, acceptedBy: String(WAITER),
    });

    const row = rowFor(after, bar)!;
    expect(row.status).toBe('collected');
    expect(row.acceptedBy).toBe(String(WAITER));
    expect(row.acceptedAt).toBeInstanceOf(Date);
    // The stall's own stamp survives — a dispute needs both halves.
    expect(row.handedOutBy).toBe(BAR_OP);
  });

  it('refuses to accept stock the stall never released', async () => {
    const { tableId, kitchen } = await released();

    await expect(TableService.accept({
      tableId, eventId: String(EVENT), merchantId: kitchen, acceptedBy: String(WAITER),
    })).rejects.toThrow(TableFulfilmentStateError);
  });

  it('refuses a second accept', async () => {
    const { tableId, bar } = await released();
    const args = { tableId, eventId: String(EVENT), merchantId: bar, acceptedBy: String(WAITER) };
    await TableService.accept(args);

    await expect(TableService.accept(args)).rejects.toThrow(TableFulfilmentStateError);
  });
});

describe('a stall only ever sees its own half of a table', () => {
  it('projects this stall\'s lines and a subtotal of just those', async () => {
    const { table, bar, kitchen } = await twoStallTable();
    await settle(table, '04a10009', 'f9');

    const [forBar] = await TableService.listForStall({
      eventId: String(EVENT), merchantId: bar,
    });

    expect(forBar!.items).toHaveLength(1);
    expect(String(forBar!.items[0]!.merchantId)).toBe(bar);
    // 3000 (the beer), NOT 7500 — the kitchen's burger is none of the bar's
    // business, and neither is what the guest paid overall.
    expect(forBar!.subtotal).toBe(3000);
    expect(forBar!.items.some((i) => String(i.merchantId) === kitchen)).toBe(false);
  });

  it('filters to the status the stall asked for', async () => {
    const { table, bar } = await twoStallTable();
    const settled = await settle(table, '04a10010', 'f10');

    expect(await TableService.listForStall({ eventId: String(EVENT), merchantId: bar, status: 'handed_out' }))
      .toHaveLength(0);

    await TableService.handOut({
      tableId: String(settled._id), eventId: String(EVENT), merchantId: bar, handedOutBy: BAR_OP,
    });

    expect(await TableService.listForStall({ eventId: String(EVENT), merchantId: bar, status: 'handed_out' }))
      .toHaveLength(1);
    expect(await TableService.listForStall({ eventId: String(EVENT), merchantId: bar, status: 'paid' }))
      .toHaveLength(0);
  });

  it('never lists a table this stall has no line on', async () => {
    const { table } = await twoStallTable();
    await settle(table, '04a10011', 'f11');
    const stranger = await seedStall({ price: 900, onHand: 5, name: 'Water' });

    expect(await TableService.listForStall({ eventId: String(EVENT), merchantId: stranger.merchantId }))
      .toEqual([]);
  });
});

describe('the waiter\'s three tabs', () => {
  it('reads an open table as New', async () => {
    const { table } = await twoStallTable();
    const listed = await TableService.list(String(EVENT), { tab: 'new' });
    expect(listed.map((t) => String(t._id))).toContain(String(table._id));
  });

  it('moves a settled table to Paid, and to Collected only once every stall is done', async () => {
    const { table, bar, kitchen } = await twoStallTable();
    const settled = await settle(table, '04a10012', 'f12');
    const id = String(settled._id);
    const ids = async (tab: 'new' | 'paid' | 'collected') =>
      (await TableService.list(String(EVENT), { tab })).map((t) => String(t._id));

    expect(await ids('new')).not.toContain(id);
    expect(await ids('paid')).toContain(id);

    // Bar done, Kitchen still holding the food — still Paid, not Collected.
    for (const merchantId of [bar]) {
      await TableService.handOut({ tableId: id, eventId: String(EVENT), merchantId, handedOutBy: BAR_OP });
      await TableService.accept({ tableId: id, eventId: String(EVENT), merchantId, acceptedBy: String(WAITER) });
    }
    expect(await ids('paid')).toContain(id);
    expect(await ids('collected')).not.toContain(id);

    await TableService.handOut({ tableId: id, eventId: String(EVENT), merchantId: kitchen, handedOutBy: BAR_OP });
    await TableService.accept({ tableId: id, eventId: String(EVENT), merchantId: kitchen, acceptedBy: String(WAITER) });

    expect(await ids('collected')).toContain(id);
    expect(await ids('paid')).not.toContain(id);
  });

  it('shows a voided table in no tab at all', async () => {
    const { table } = await twoStallTable();
    await TableService.voidTable({
      tableId: String(table._id), eventId: String(EVENT), reason: 'walked out', voidedBy: String(WAITER),
    });
    for (const tab of ['new', 'paid', 'collected'] as const) {
      expect((await TableService.list(String(EVENT), { tab })).map((t) => String(t._id)))
        .not.toContain(String(table._id));
    }
  });

  it('reads a table settled before fulfilment existed as Collected — nothing is outstanding', async () => {
    const legacy = await Table.create({
      eventId: EVENT, label: 'LEGACY', status: 'settled', openedBy: String(WAITER),
      items: [], subtotal: 0, settledAt: new Date(),
    });
    const ids = (await TableService.list(String(EVENT), { tab: 'collected' })).map((t) => String(t._id));
    expect(ids).toContain(String(legacy._id));
  });
});

describe('searching the floor', () => {
  it('matches part of a label, whether it is a number or a name', async () => {
    await Table.create([
      { eventId: EVENT, label: 'Mza', status: 'open', openedBy: 'w', items: [], subtotal: 0 },
      { eventId: EVENT, label: '12', status: 'open', openedBy: 'w', items: [], subtotal: 0 },
    ]);
    const labels = async (q: string) =>
      (await TableService.list(String(EVENT), { q })).map((t) => t.label);

    expect(await labels('mz')).toEqual(['Mza']);
    expect(await labels('12')).toEqual(['12']);
  });

  it('treats a regex metacharacter as text, not a pattern', async () => {
    await Table.create([
      { eventId: EVENT, label: 'A.B', status: 'open', openedBy: 'w', items: [], subtotal: 0 },
      { eventId: EVENT, label: 'AXB', status: 'open', openedBy: 'w', items: [], subtotal: 0 },
    ]);
    const found = await TableService.list(String(EVENT), { q: 'A.B' });
    expect(found.map((t) => t.label)).toEqual(['A.B']);
  });
});
