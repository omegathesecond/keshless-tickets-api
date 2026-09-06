import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Table } from '@models/table.model';

const EVENT = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await connectTestDb();
  await Table.syncIndexes();
});
afterEach(clearTestDb);
afterAll(disconnectTestDb);

const open = (label: string) => ({
  eventId: EVENT, label, status: 'open' as const, openedBy: 'w1', items: [], subtotal: 0,
});

describe('a table', () => {
  it('cannot be open twice under one label at one event', async () => {
    await Table.create(open('7'));
    await expect(Table.create(open('7'))).rejects.toThrow(/duplicate key|E11000/i);
  });

  it('frees the label again once settled, so table 7 can be reused', async () => {
    const first = await Table.create(open('7'));
    await Table.updateOne({ _id: first._id }, { $set: { status: 'settled', settledAt: new Date() } });
    const second = await Table.create(open('7'));
    expect(second.label).toBe('7');
  });

  it('rejects a non-integer line price', async () => {
    // Money is integer cents everywhere. A float here would round somewhere
    // downstream, and a bill that does not add up is worse than a refusal.
    await expect(Table.create({
      ...open('8'),
      items: [{
        merchantId: new mongoose.Types.ObjectId(), productId: new mongoose.Types.ObjectId(),
        name: 'Beer', unitPrice: 30.5, qty: 1, addedBy: 'w1', addedAt: new Date(),
      }],
    })).rejects.toThrow(/integer/i);
  });
});

describe('a table\'s fulfilment rows', () => {
  const stall = () => new mongoose.Types.ObjectId();

  it('defaults to none — fulfilment begins at settlement, not when a line lands', async () => {
    const table = await Table.create(open('20'));
    expect(table.fulfilment).toEqual([]);
  });

  it('holds one row per stall, each starting at paid', async () => {
    const [bar, kitchen] = [stall(), stall()];
    const table = await Table.create({
      ...open('21'),
      fulfilment: [{ merchantId: bar }, { merchantId: kitchen }],
    });
    expect(table.fulfilment.map((f) => f.status)).toEqual(['paid', 'paid']);
    expect(table.fulfilment.map((f) => String(f.merchantId))).toEqual([String(bar), String(kitchen)]);
  });

  it('refuses a status outside the handover sequence', async () => {
    await expect(Table.create({
      ...open('22'),
      fulfilment: [{ merchantId: stall(), status: 'in_transit' }],
    })).rejects.toThrow(/is not a valid enum value|validation/i);
  });

  it('carries both halves of the handshake — who released it and who took it', async () => {
    const table = await Table.create({
      ...open('23'),
      fulfilment: [{
        merchantId: stall(), status: 'collected',
        handedOutAt: new Date(), handedOutBy: 'op-1',
        acceptedAt: new Date(), acceptedBy: 'waiter-1',
      }],
    });
    const row = table.fulfilment[0]!;
    expect(row.handedOutBy).toBe('op-1');
    expect(row.acceptedBy).toBe('waiter-1');
  });

  it('keys a row by its stall, so a row needs no id of its own', async () => {
    const table = await Table.create({ ...open('24'), fulfilment: [{ merchantId: stall() }] });
    expect((table.fulfilment[0] as any)._id).toBeUndefined();
  });
});
