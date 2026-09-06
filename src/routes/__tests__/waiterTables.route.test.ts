import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { WAITER_PERMISSIONS, WaiterPermission } from '@interfaces/waiter.interface';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { StockService } from '@services/stock.service';
import { ProductCategory, StockMovementReason } from '@interfaces/stock.interface';
import { WalletService } from '@services/wallet.service';
import { Wallet } from '@models/wallet.model';
import { Waiter } from '@models/waiter.model';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { Table } from '@models/table.model';
import { enrolTags } from '@/__tests__/helpers/eventTags';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

// addItem writes its table-push + stock-CAS in one transaction
// (StockService.applyMovement always opens one), so this suite needs a
// replica set, not the standalone mongod the open/list tests alone would need.
beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let waiterSeq = 0;

/**
 * One waiter, working one freshly-created cashless event, token in hand.
 *
 * The Waiter ROW is real, not just the token: revocation is re-resolved from
 * that row on every request, so a token naming no row is refused outright.
 * `waiterId` is returned so a test can fire the waiter mid-shift.
 */
async function seedFloor(permissions: string[] = WAITER_PERMISSIONS, status = EventStatus.PUBLISHED) {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future,
    endTime: future, status, cashless: true, ticketTypes: [],
  });
  const waiter = await Waiter.create({
    fullName: 'Thabo', loginCode: `WTRT${waiterSeq++}`, pin: '123456',
    scope: 'organizer', vendorId, eventId: event._id,
    // The ROW is what authorizes (authenticateWaiter re-derives from it every
    // request), so a suite asking for a settling waiter has to grant one —
    // putting SETTLE_TABLES in the token claim alone proves nothing.
    grants: permissions.includes(WaiterPermission.SETTLE_TABLES)
      ? [OperatorGrant.SETTLE_TABLES] : [],
  });
  const token = jwt.sign({
    scope: 'waiter', userType: 'waiter', waiterId: String(waiter._id),
    role: 'waiter', permissions, isSuperAdmin: false,
    fullName: 'Thabo', vendorId: String(vendorId), eventId: String(event._id),
  }, JWT_SECRET);
  return { eventId: String(event._id), token, waiterId: String(waiter._id) };
}

/** A stocked stall on a given event, for the addItem route tests. */
async function seedStallOn(eventId: string, opts: { price: number; onHand: number }) {
  const merchant = await Merchant.create({ name: 'Test Stall', eventId });
  const product = await Product.create({
    eventId, name: 'Beer', category: ProductCategory.BEER, price: opts.price,
  });
  await StockService.applyMovement({
    eventId, merchantId: merchant._id, productId: product._id, delta: opts.onHand,
    reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: String(merchant._id),
  });
  return { merchantId: String(merchant._id), productId: String(product._id) };
}

/** A tag holding `amount` cents at this event, issued the way the desk issues one. */
async function fundedTag(eventId: string, bandUid: string, amount: number) {
  await enrolTags(eventId, bandUid);
  const { wallet } = await WalletService.ensureStandaloneWalletForBand({ eventId, bandUid });
  await WalletService.topUpCash({
    walletId: String(wallet._id), eventId, amount,
    recordedBy: 'route-test-desk', recordedByType: 'Cashier', clientTxnId: `fund-${wallet._id}`,
  });
  return String(wallet._id);
}

/** An open table at `eventId` carrying `qty` of one stall's product. */
async function tableWithDrinks(
  eventId: string, token: string, opts: { label: string; price: number; qty: number },
) {
  const { merchantId, productId } = await seedStallOn(eventId, { price: opts.price, onHand: 20 });
  const opened = await request(app).post('/api/waiter/tables')
    .set('Authorization', `Bearer ${token}`).send({ label: opts.label });
  const tableId = opened.body.data._id;
  await request(app).post(`/api/waiter/tables/${tableId}/items`)
    .set('Authorization', `Bearer ${token}`).send({ merchantId, productId, qty: opts.qty });
  return { tableId, merchantId, productId };
}

describe('waiter tables — open and list', () => {
  it('opens a table by number', async () => {
    const { token } = await seedFloor();
    const res = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });

    expect(res.status).toBe(201);
    expect(res.body.data.label).toBe('7');
    expect(res.body.data.status).toBe('open');
    expect(res.body.data.subtotal).toBe(0);
  });

  it('refuses a second open table under the same number', async () => {
    const { token } = await seedFloor();
    await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });

    const again = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });

    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already open/i);
  });

  it('requires a label', async () => {
    const { token } = await seedFloor();
    const res = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it('lists only this event tables', async () => {
    const mine = await seedFloor();
    const other = await seedFloor();
    await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${mine.token}`).send({ label: '7' });

    const res = await request(app).get('/api/waiter/tables')
      .set('Authorization', `Bearer ${other.token}`);
    expect(res.body.data.tables).toEqual([]);
  });
});

describe('waiter tables — add an item', () => {
  it('adds an item from a stall onto a table', async () => {
    const { eventId, token } = await seedFloor();
    const { merchantId, productId } = await seedStallOn(eventId, { price: 3000, onHand: 10 });
    const opened = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });
    const tableId = opened.body.data._id;

    const res = await request(app).post(`/api/waiter/tables/${tableId}/items`)
      .set('Authorization', `Bearer ${token}`).send({ merchantId, productId, qty: 2 });

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].unitPrice).toBe(3000);
    expect(res.body.data.subtotal).toBe(6000);
  });

  // Proves the route is actually GATED, not just that the service works when
  // called directly. A 401 here would mean the request never reached
  // requireWaiterPermission at all — see the gate-removal check in the
  // report for how this was verified to actually depend on the middleware.
  it('serves an emptied token claim — the ROW carries the role floor', async () => {
    const { token } = await seedFloor([]);
    const someTableId = new mongoose.Types.ObjectId().toString();

    const res = await request(app).post(`/api/waiter/tables/${someTableId}/items`)
      .set('Authorization', `Bearer ${token}`).send({
        merchantId: new mongoose.Types.ObjectId().toString(),
        productId: new mongoose.Types.ObjectId().toString(),
        qty: 1,
      });

    expect(res.status).not.toBe(403);
  });

  // Proves loadWaiterEvent's eventId — taken from the verified JWT, never the
  // request body — is what scopes the table lookup. The stall/product here
  // are seeded on the WAITER'S OWN event and so pass their own checks fine;
  // only the table itself belongs elsewhere, isolating this to the table scope.
  it('refuses a table that belongs to another event', async () => {
    const other = await seedFloor();
    const otherTable = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${other.token}`).send({ label: '7' });
    const otherTableId = otherTable.body.data._id;

    const mine = await seedFloor();
    const { merchantId, productId } = await seedStallOn(mine.eventId, { price: 3000, onHand: 10 });

    const res = await request(app).post(`/api/waiter/tables/${otherTableId}/items`)
      .set('Authorization', `Bearer ${mine.token}`).send({ merchantId, productId, qty: 1 });

    expect(res.status).not.toBe(200);
    expect(res.body.message).toMatch(/not found/i);
  });

  // The controller maps TableService's plain-Error messages to status codes
  // by regex — proves "stall is closed" lands on 400, not the 500 it would
  // fall through to if the mapping were never extended for it.
  it('refuses an item from a suspended stall with a 400, message says it is closed', async () => {
    const { eventId, token } = await seedFloor();
    const { merchantId, productId } = await seedStallOn(eventId, { price: 3000, onHand: 10 });
    await Merchant.updateOne({ _id: merchantId }, { $set: { status: 'suspended' } });
    const opened = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });
    const tableId = opened.body.data._id;

    const res = await request(app).post(`/api/waiter/tables/${tableId}/items`)
      .set('Authorization', `Bearer ${token}`).send({ merchantId, productId, qty: 1 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/closed/i);
  });
});

describe('waiter tables — remove an item', () => {
  it('removes a line and returns its stock', async () => {
    const { eventId, token } = await seedFloor();
    const { merchantId, productId } = await seedStallOn(eventId, { price: 3000, onHand: 10 });
    const opened = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });
    const tableId = opened.body.data._id;
    const added = await request(app).post(`/api/waiter/tables/${tableId}/items`)
      .set('Authorization', `Bearer ${token}`).send({ merchantId, productId, qty: 2 });
    const lineId = added.body.data.items[0]._id;

    const res = await request(app).delete(`/api/waiter/tables/${tableId}/items/${lineId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(0);
    expect(res.body.data.subtotal).toBe(0);
  });

  // Proves the route is actually GATED, not just that the service works when
  // called directly. A 401 here would mean the request never reached
  // requireWaiterPermission at all — see the gate-removal check in the
  // report for how this was verified to actually depend on the middleware.
  it('serves an emptied token claim — the ROW carries the role floor', async () => {
    const { token } = await seedFloor([]);
    const someTableId = new mongoose.Types.ObjectId().toString();
    const someLineId = new mongoose.Types.ObjectId().toString();

    const res = await request(app).delete(`/api/waiter/tables/${someTableId}/items/${someLineId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).not.toBe(403);
  });
});

describe('waiter tables — void a table', () => {
  it('closes an unpaid table, keeping the loss on record', async () => {
    const { eventId, token } = await seedFloor();
    const { merchantId, productId } = await seedStallOn(eventId, { price: 3000, onHand: 10 });
    const opened = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });
    const tableId = opened.body.data._id;
    await request(app).post(`/api/waiter/tables/${tableId}/items`)
      .set('Authorization', `Bearer ${token}`).send({ merchantId, productId, qty: 2 });

    const res = await request(app).post(`/api/waiter/tables/${tableId}/void`)
      .set('Authorization', `Bearer ${token}`).send({ reason: 'walked out' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('voided');
    expect(res.body.data.voidReason).toBe('walked out');
    expect(res.body.data.subtotal).toBe(6000);
  });

  // Proves the route is actually GATED, not just that the service works when
  // called directly. A 401 here would mean the request never reached
  // requireWaiterPermission at all — see the gate-removal check in the
  // report for how this was verified to actually depend on the middleware.
  it('serves an emptied token claim — the ROW carries the role floor', async () => {
    const { token } = await seedFloor([]);
    const someTableId = new mongoose.Types.ObjectId().toString();

    const res = await request(app).post(`/api/waiter/tables/${someTableId}/void`)
      .set('Authorization', `Bearer ${token}`).send({ reason: 'walked out' });

    expect(res.status).not.toBe(403);
  });
});

describe('waiter tables — settle a table', () => {
  /** A waiter who may both serve AND take money. */
  const canSettle = [...WAITER_PERMISSIONS, WaiterPermission.SETTLE_TABLES];

  it('charges the whole tab to one tapped tag', async () => {
    const { eventId, token } = await seedFloor(canSettle);
    const { tableId } = await tableWithDrinks(eventId, token, { label: '7', price: 3000, qty: 2 });
    const walletId = await fundedTag(eventId, '04a22b1c', 10000);

    const res = await request(app).post(`/api/waiter/tables/${tableId}/settle`)
      .set('Authorization', `Bearer ${token}`).send({ bandUid: '04a22b1c', clientTxnId: 's1' });

    expect(res.status).toBe(200);
    expect(res.body.data.walletBalance).toBe(4000);
    expect(res.body.data.table.status).toBe('settled');
    expect(res.body.data.charges).toHaveLength(1);
    expect(res.body.data.charges[0].amount).toBe(6000);
    expect((await Wallet.findById(walletId))!.balance).toBe(4000);
  });

  // 402, not a bare "declined": the payload has to tell the waiter how much
  // short the tag is, or the guest has nothing to act on at the desk. The
  // message itself names no currency (the server does not know the event's) —
  // the integer-cent fields below are what the POS actually formats.
  it('402s a tag that cannot cover the tab, and carries the integer cents a client can format', async () => {
    const { eventId, token } = await seedFloor(canSettle);
    const { tableId } = await tableWithDrinks(eventId, token, { label: '7', price: 3000, qty: 2 });
    await fundedTag(eventId, '04a22b1c', 4500);

    const res = await request(app).post(`/api/waiter/tables/${tableId}/settle`)
      .set('Authorization', `Bearer ${token}`).send({ bandUid: '04a22b1c', clientTxnId: 's1' });

    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/15\.00 short/);
    expect(res.body.message).not.toMatch(/R\d|E\d/);
    const errorPayload = JSON.parse(res.body.error);
    expect(errorPayload).toMatchObject({ reason: 'insufficient_balance', total: 6000, balance: 4500, short: 1500 });
  });

  it('409s a second settle of an already-settled table', async () => {
    const { eventId, token } = await seedFloor(canSettle);
    const { tableId } = await tableWithDrinks(eventId, token, { label: '7', price: 3000, qty: 1 });
    await fundedTag(eventId, '04a22b1c', 10000);
    const body = { bandUid: '04a22b1c', clientTxnId: 's1' };
    await request(app).post(`/api/waiter/tables/${tableId}/settle`)
      .set('Authorization', `Bearer ${token}`).send(body);

    const again = await request(app).post(`/api/waiter/tables/${tableId}/settle`)
      .set('Authorization', `Bearer ${token}`).send({ ...body, clientTxnId: 's2' });

    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/already settled/i);
  });

  it('404s a tag that carries no wallet at this event', async () => {
    const { eventId, token } = await seedFloor(canSettle);
    const { tableId } = await tableWithDrinks(eventId, token, { label: '7', price: 3000, qty: 1 });

    const res = await request(app).post(`/api/waiter/tables/${tableId}/settle`)
      .set('Authorization', `Bearer ${token}`).send({ bandUid: '04a22b1c', clientTxnId: 's1' });

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/no wallet/i);
  });

  // THE gate that matters: serving a table and taking money for it are
  // separate grants. A waiter with the full default permission set still has
  // no business settling, because SETTLE_TABLES is not in it. A 200 here would
  // mean the route were gated on MANAGE_TABLES — every waiter on the floor
  // able to charge a guest's tag.
  it('403s a waiter holding MANAGE_TABLES but NOT SETTLE_TABLES', async () => {
    const { eventId, token } = await seedFloor(WAITER_PERMISSIONS);
    const { tableId } = await tableWithDrinks(eventId, token, { label: '7', price: 3000, qty: 1 });
    await fundedTag(eventId, '04a22b1c', 10000);

    const res = await request(app).post(`/api/waiter/tables/${tableId}/settle`)
      .set('Authorization', `Bearer ${token}`).send({ bandUid: '04a22b1c', clientTxnId: 's1' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/waiter:settle_tables/);
    // And nothing moved.
    expect((await Wallet.findOne({ bandUid: '04a22b1c' }))!.balance).toBe(10000);
  });
});

/**
 * Revocation and event lifecycle.
 *
 * A waiter token is minted for 7 days and verified with no database lookup, so
 * the only thing standing between a fired waiter and a guest's wallet is a
 * per-request re-read of their row. Every test here therefore asserts on a
 * MONEY path — a settle — and checks the wallet balance afterwards: a refusal
 * that still moved the money would pass a status-code-only assertion.
 */
describe('waiter tables — revocation and event lifecycle', () => {
  const canSettle = [...WAITER_PERMISSIONS, WaiterPermission.SETTLE_TABLES];

  /** A settle-ready floor: a tab worth 6000 and a tag holding 10000. */
  async function readyToSettle(status = EventStatus.PUBLISHED) {
    const floor = await seedFloor(canSettle, status);
    const { tableId } = await tableWithDrinks(floor.eventId, floor.token, {
      label: '7', price: 3000, qty: 2,
    });
    await fundedTag(floor.eventId, '04a22b1c', 10000);
    return { ...floor, tableId };
  }

  /** Nothing moved: the tag is untouched and the tab is still open. */
  async function nothingMoved(tableId: string) {
    expect((await Wallet.findOne({ bandUid: '04a22b1c' }))!.balance).toBe(10000);
    expect((await Table.findById(tableId))!.status).toBe('open');
  }

  it('refuses a settle by a waiter deactivated AFTER they logged in', async () => {
    const { token, tableId, waiterId } = await readyToSettle();

    // The organizer hits Disable. The token in the waiter's hand is untouched
    // and still cryptographically valid for another week.
    await Waiter.updateOne({ _id: waiterId }, { $set: { isActive: false } });

    const res = await request(app).post(`/api/waiter/tables/${tableId}/settle`)
      .set('Authorization', `Bearer ${token}`).send({ bandUid: '04a22b1c', clientTxnId: 's1' });

    // Refused at AUTHENTICATION now, not at event scope: authenticateWaiter
    // re-reads the row before any handler runs.
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/deactivated/i);
    await nothingMoved(tableId);
  });

  it('refuses a settle by a waiter whose row was deleted after login', async () => {
    const { token, tableId, waiterId } = await readyToSettle();
    await Waiter.deleteOne({ _id: waiterId });

    const res = await request(app).post(`/api/waiter/tables/${tableId}/settle`)
      .set('Authorization', `Bearer ${token}`).send({ bandUid: '04a22b1c', clientTxnId: 's1' });

    // Refused at AUTHENTICATION now, not at event scope: authenticateWaiter
    // re-reads the row before any handler runs.
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/deactivated/i);
    await nothingMoved(tableId);
  });

  it('refuses a settle at an event that is no longer published', async () => {
    const { eventId, token, tableId } = await readyToSettle();
    await Event.updateOne({ _id: eventId }, { $set: { status: EventStatus.CANCELLED } });

    const res = await request(app).post(`/api/waiter/tables/${tableId}/settle`)
      .set('Authorization', `Bearer ${token}`).send({ bandUid: '04a22b1c', clientTxnId: 's1' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not published/i);
    await nothingMoved(tableId);
  });

  it('refuses to open a table at a draft event', async () => {
    const { token } = await seedFloor(WAITER_PERMISSIONS, EventStatus.DRAFT);

    const res = await request(app).post('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`).send({ label: '7' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not published/i);
  });

  // A malformed eventId claim casts to nothing. Unguarded it throws out of an
  // async handler Express 4 does not await, so the request never answers at
  // all — the one way loadWaiterEvent can break its always-respond contract.
  it('answers 404 instead of hanging on a malformed event id in the token', async () => {
    await seedFloor();
    const waiter = await Waiter.create({
      fullName: 'Thabo', loginCode: `WTRT${waiterSeq++}`, pin: '123456',
      scope: 'organizer', vendorId: new mongoose.Types.ObjectId(),
      eventId: new mongoose.Types.ObjectId(),
    });
    const token = jwt.sign({
      scope: 'waiter', userType: 'waiter', waiterId: String(waiter._id),
      role: 'waiter', permissions: WAITER_PERMISSIONS, isSuperAdmin: false,
      fullName: 'Thabo', eventId: 'not-an-object-id',
    }, JWT_SECRET);

    const res = await request(app).get('/api/waiter/tables')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
  });
});
