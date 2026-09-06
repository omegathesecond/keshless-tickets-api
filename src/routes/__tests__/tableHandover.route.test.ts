// The handover routes: the stall's half (POST /api/merchant/tables/:id/hand-out,
// GET /api/merchant/tables) and the waiter's (POST /api/waiter/tables/:id/
// stalls/:merchantId/accept).
//
// Driven end to end through HTTP rather than the service — the isolation that
// matters here is a ROUTE property (one stall's token must not read another
// stall's lines), and the service-level suite cannot prove a gate exists.
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectLedgerTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { enrolTags } from '@/__tests__/helpers/eventTags';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Merchant } from '@models/merchant.model';
import { MerchantOperator } from '@models/merchantOperator.model';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';
import { Product } from '@models/product.model';
import { Waiter } from '@models/waiter.model';
import { Table } from '@models/table.model';
import { WalletService } from '@services/wallet.service';
import { StockService } from '@services/stock.service';
import { ProductCategory, StockMovementReason } from '@interfaces/stock.interface';

beforeAll(connectLedgerTestDb, 60000);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let seq = 0;

interface Floor {
  eventId: string;
  waiterAuth: string;
  tableId: string;
  bar: { merchantId: string; auth: string; operatorId: string };
  kitchen: { merchantId: string; auth: string };
}

async function stall(eventId: string, name: string) {
  const merchant = await Merchant.create({ name, eventId });
  const operator = await MerchantOperator.create({
    fullName: `${name} operator`, merchantId: merchant._id, eventId,
    loginCode: `H${seq++}`.padStart(6, '0'), pin: '111111', grants: [OperatorGrant.MANAGE_STOCK],
  });
  const product = await Product.create({
    eventId, name: `${name} item`, category: ProductCategory.BEER, price: 3000,
  });
  await StockService.applyMovement({
    eventId, merchantId: merchant._id, productId: product._id, delta: 20,
    reason: StockMovementReason.RECEIVE, byType: 'Organizer', by: String(merchant._id),
  });
  const auth = `Bearer ${jwt.sign({
    scope: 'merchant', merchantId: String(merchant._id), merchantOperatorId: String(operator._id),
    operatorName: 'Op', eventId: String(eventId), name,
    permissions: [MerchantPermission.CHARGE],
  }, JWT_SECRET)}`;
  return { merchantId: String(merchant._id), productId: String(product._id), auth, operatorId: String(operator._id) };
}

/** A settled two-stall table, plus tokens for the waiter and each stall. */
async function settledFloor(): Promise<Floor> {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future,
    endTime: future, status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const eventId = String(event._id);

  const waiter = await Waiter.create({
    fullName: 'Thabo', loginCode: `WTRH${seq++}`, pin: '123456',
    scope: 'organizer', vendorId, eventId: event._id, grants: [OperatorGrant.SETTLE_TABLES],
  });
  const waiterAuth = `Bearer ${jwt.sign({
    scope: 'waiter', userType: 'waiter', waiterId: String(waiter._id), role: 'waiter',
    permissions: [], isSuperAdmin: false, fullName: 'Thabo',
    vendorId: String(vendorId), eventId,
  }, JWT_SECRET)}`;

  const bar = await stall(eventId, 'Main Bar');
  const kitchen = await stall(eventId, 'Grill');

  const opened = await request(app).post('/api/waiter/tables')
    .set('Authorization', waiterAuth).send({ label: `T${seq++}` });
  const tableId = opened.body.data._id;
  for (const s of [bar, kitchen]) {
    await request(app).post(`/api/waiter/tables/${tableId}/items`)
      .set('Authorization', waiterAuth)
      .send({ merchantId: s.merchantId, productId: s.productId, qty: 1 });
  }

  // Padded: a band uid must be at least 8 hex chars, and a single-digit
  // counter would fall short of that.
  const tag = `04b0${String(seq++).padStart(4, '0')}`;
  await enrolTags(eventId, tag);
  const { wallet } = await WalletService.ensureStandaloneWalletForBand({ eventId, bandUid: tag });
  await WalletService.topUpCash({
    walletId: String(wallet._id), eventId, amount: 50000,
    recordedBy: 'desk', recordedByType: 'Cashier', clientTxnId: `fund-${wallet._id}`,
  });
  await request(app).post(`/api/waiter/tables/${tableId}/settle`)
    .set('Authorization', waiterAuth).send({ bandUid: tag, clientTxnId: `st-${seq++}` });

  return { eventId, waiterAuth, tableId, bar, kitchen };
}

describe('GET /api/merchant/tables', () => {
  it('lists a settled table this stall owes stock to', async () => {
    const f = await settledFloor();
    const res = await request(app).get('/api/merchant/tables').set('Authorization', f.bar.auth);

    expect(res.status).toBe(200);
    expect(res.body.data.tables).toHaveLength(1);
    expect(res.body.data.tables[0].fulfilment.status).toBe('paid');
  });

  it('shows a stall ONLY its own lines and its own money', async () => {
    const f = await settledFloor();
    const res = await request(app).get('/api/merchant/tables').set('Authorization', f.bar.auth);

    const table = res.body.data.tables[0];
    expect(table.items).toHaveLength(1);
    expect(String(table.items[0].merchantId)).toBe(f.bar.merchantId);
    // 3000 for the bar's own line — not the 6000 the guest paid across both
    // stalls. The whole-tab total is none of this counter's business.
    expect(table.subtotal).toBe(3000);
  });

  it('never lists an OPEN table — nothing is handed over unpaid', async () => {
    const f = await settledFloor();
    await request(app).post('/api/waiter/tables')
      .set('Authorization', f.waiterAuth).send({ label: 'unpaid' });

    const res = await request(app).get('/api/merchant/tables').set('Authorization', f.bar.auth);
    expect(res.body.data.tables.map((t: any) => t.label)).not.toContain('unpaid');
  });

  it('filters by status, ignoring a value that is not one', async () => {
    const f = await settledFloor();
    const list = async (q: string) =>
      (await request(app).get(`/api/merchant/tables?status=${q}`).set('Authorization', f.bar.auth))
        .body.data.tables;

    expect(await list('handed_out')).toHaveLength(0);
    expect(await list('paid')).toHaveLength(1);
    // Junk must not silently widen the query into "everything".
    expect(await list('nonsense')).toHaveLength(1);
  });

  it('401s without a merchant token', async () => {
    await settledFloor();
    const res = await request(app).get('/api/merchant/tables');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/merchant/tables/:id/hand-out', () => {
  const handOut = (tableId: string, auth: string) =>
    request(app).post(`/api/merchant/tables/${tableId}/hand-out`).set('Authorization', auth);

  it('releases this stall\'s stock and leaves the other stall alone', async () => {
    const f = await settledFloor();

    const res = await handOut(f.tableId, f.bar.auth);

    expect(res.status).toBe(200);
    expect(res.body.data.fulfilment.status).toBe('handed_out');
    const stored = await Table.findById(f.tableId);
    const kitchenRow = stored!.fulfilment.find((r) => String(r.merchantId) === f.kitchen.merchantId);
    expect(kitchenRow!.status).toBe('paid');
  });

  it('stamps the PERSON on the till, not the stall', async () => {
    const f = await settledFloor();
    await handOut(f.tableId, f.bar.auth);

    const stored = await Table.findById(f.tableId);
    const row = stored!.fulfilment.find((r) => String(r.merchantId) === f.bar.merchantId);
    expect(row!.handedOutBy).toBe(f.bar.operatorId);
  });

  it('409s a second hand-out', async () => {
    const f = await settledFloor();
    await handOut(f.tableId, f.bar.auth);

    const res = await handOut(f.tableId, f.bar.auth);
    expect(res.status).toBe(409);
  });

  it('404s a table this stall has nothing on', async () => {
    const f = await settledFloor();
    const stranger = await stall(f.eventId, 'Coffee');

    const res = await handOut(f.tableId, stranger.auth);
    expect(res.status).toBe(404);
  });

  it('404s a malformed id rather than hanging on a cast error', async () => {
    const f = await settledFloor();
    const res = await handOut('not-an-id', f.bar.auth);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/waiter/tables/:id/stalls/:merchantId/accept', () => {
  const accept = (f: Floor, merchantId: string) =>
    request(app).post(`/api/waiter/tables/${f.tableId}/stalls/${merchantId}/accept`)
      .set('Authorization', f.waiterAuth);

  it('closes the handshake once the stall has released the stock', async () => {
    const f = await settledFloor();
    await request(app).post(`/api/merchant/tables/${f.tableId}/hand-out`)
      .set('Authorization', f.bar.auth);

    const res = await accept(f, f.bar.merchantId);

    expect(res.status).toBe(200);
    const row = res.body.data.fulfilment.find((r: any) => String(r.merchantId) === f.bar.merchantId);
    expect(row.status).toBe('collected');
  });

  it('409s stock the stall has not released — the waiter cannot close it alone', async () => {
    const f = await settledFloor();
    const res = await accept(f, f.bar.merchantId);
    expect(res.status).toBe(409);
  });

  it('404s a stall with nothing on this table', async () => {
    const f = await settledFloor();
    const stranger = await stall(f.eventId, 'Coffee');
    const res = await accept(f, stranger.merchantId);
    expect(res.status).toBe(404);
  });

  it('404s a malformed stall id rather than hanging on a cast error', async () => {
    const f = await settledFloor();
    const res = await accept(f, 'not-an-id');
    expect(res.status).toBe(404);
  });

  it('401s without a waiter token', async () => {
    const f = await settledFloor();
    const res = await request(app)
      .post(`/api/waiter/tables/${f.tableId}/stalls/${f.bar.merchantId}/accept`);
    expect(res.status).toBe(401);
  });
});

describe('the waiter list gains tabs and search', () => {
  const list = (f: Floor, query: string) =>
    request(app).get(`/api/waiter/tables?${query}`).set('Authorization', f.waiterAuth);

  it('separates New from Paid', async () => {
    const f = await settledFloor();
    await request(app).post('/api/waiter/tables')
      .set('Authorization', f.waiterAuth).send({ label: 'fresh' });

    const isNew = await list(f, 'tab=new');
    const paid = await list(f, 'tab=paid');

    expect(isNew.body.data.tables.map((t: any) => t.label)).toEqual(['fresh']);
    expect(paid.body.data.tables.map((t: any) => t._id)).toEqual([f.tableId]);
  });

  it('searches the label', async () => {
    const f = await settledFloor();
    await request(app).post('/api/waiter/tables')
      .set('Authorization', f.waiterAuth).send({ label: 'Mza' });

    const res = await list(f, 'q=mz');
    expect(res.body.data.tables.map((t: any) => t.label)).toEqual(['Mza']);
  });
});
