// GET /api/waiter/products — the ONE searchable, event-wide grid AddItemsSheet
// renders. A waiter serves the floor, not a stall: they must reach any stall's
// products without picking a stall first, and every tile must say which stall
// it comes from so the order goes to the right bar.
//
// The catalogue is driven off ProductStock rows, not the event's Product list,
// because a ProductStock row IS the "this stall sells this" relationship that
// TableService.addItem enforces. A tile with no row behind it could only ever
// fail on tap with "product not sold at that stall".
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { JWT_SECRET } from '@config/jwt.config';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { WAITER_PERMISSIONS, WaiterPermission } from '@interfaces/waiter.interface';
import { Waiter } from '@models/waiter.model';
import { Merchant } from '@models/merchant.model';
import { Product } from '@models/product.model';
import { ProductStock } from '@models/productStock.model';
import { ProductCategory } from '@interfaces/stock.interface';

// A pure read — no transaction anywhere on this path — so the fast standalone
// mongod is enough. Stock rows are written directly rather than through
// StockService (whose movements always open a transaction).
beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let waiterSeq = 0;

/** One waiter working one cashless event, token in hand. The Waiter ROW is
 *  real, not just the token: the event scope is re-resolved from it per
 *  request, so `waiterId` is returned for the revocation tests to fire them. */
async function seedFloor(
  permissions: string[] = WAITER_PERMISSIONS,
  event: { status?: EventStatus; cashless?: boolean } = {},
) {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const ev = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future,
    endTime: future, status: event.status ?? EventStatus.PUBLISHED,
    cashless: event.cashless ?? true, ticketTypes: [],
  });
  const waiter = await Waiter.create({
    fullName: 'Thabo', loginCode: `WTRP${waiterSeq++}`, pin: '123456',
    scope: 'organizer', vendorId, eventId: ev._id,
  });
  const token = jwt.sign({
    scope: 'waiter', userType: 'waiter', waiterId: String(waiter._id),
    role: 'waiter', permissions, isSuperAdmin: false,
    fullName: 'Thabo', vendorId: String(vendorId), eventId: String(ev._id),
  }, JWT_SECRET);
  return { eventId: String(ev._id), token, waiterId: String(waiter._id) };
}

const seedStall = async (eventId: string, name: string, status = 'active') =>
  String((await Merchant.create({ name, eventId, status }))._id);

const seedProduct = async (eventId: string, name: string, extra: Record<string, unknown> = {}) =>
  String((await Product.create({
    eventId, name, category: ProductCategory.BEER, price: 2500, ...extra,
  }))._id);

/** Allocation IS a ProductStock row — that is the whole model. */
const allocate = (
  eventId: string, merchantId: string, productId: string,
  onHand: number, lowStockThreshold?: number,
) => ProductStock.create({ eventId, merchantId, productId, onHand, lowStockThreshold });

const get = (token: string) =>
  request(app).get('/api/waiter/products').set('Authorization', `Bearer ${token}`);

describe('the waiter product grid', () => {
  it('spans every stall at the event, naming the stall on each tile', async () => {
    const { eventId, token } = await seedFloor();
    const bar = await seedStall(eventId, 'Main Bar');
    const grill = await seedStall(eventId, 'Shisanyama');
    const beer = await seedProduct(eventId, 'Castle Lite 330ml');
    const chicken = await seedProduct(eventId, 'Quarter Chicken', { category: ProductCategory.FOOD });
    await allocate(eventId, bar, beer, 12);
    await allocate(eventId, grill, chicken, 4);

    const res = await get(token);

    expect(res.status).toBe(200);
    expect(res.body.data.products.map((p: any) => [p.productId, p.merchantId, p.merchantName]))
      .toEqual([[beer, bar, 'Main Bar'], [chicken, grill, 'Shisanyama']]);
  });

  it('lists one product once per stall that carries it, each with its own count', async () => {
    const { eventId, token } = await seedFloor();
    const bar = await seedStall(eventId, 'Main Bar');
    const kiosk = await seedStall(eventId, 'Kiosk');
    const beer = await seedProduct(eventId, 'Castle Lite 330ml');
    await allocate(eventId, bar, beer, 2, 5);
    await allocate(eventId, kiosk, beer, 0);

    const res = await get(token);

    // Same product, two tiles: the waiter picks WHICH bar to take it from, and
    // the count that decides sold-out is per stall, never the event total.
    expect(res.body.data.products.map((p: any) => [p.merchantName, p.onHand, p.status]))
      .toEqual([['Kiosk', 0, 'sold_out'], ['Main Bar', 2, 'low']]);
  });

  it("carries the same per-product fields a stall's own POS grid gets", async () => {
    const { eventId, token } = await seedFloor();
    const bar = await seedStall(eventId, 'Main Bar');
    const beer = await seedProduct(eventId, 'Castle Lite 330ml', {
      barcode: '6001234567890', imageUrl: 'https://cdn/castle.png',
      unitLabel: 'bottle', unitsPerPack: 24, packLabel: 'case',
    });
    await allocate(eventId, bar, beer, 30, 6);

    const res = await get(token);

    expect(res.body.data.products[0]).toEqual({
      productId: beer, name: 'Castle Lite 330ml', price: 2500,
      barcode: '6001234567890', category: ProductCategory.BEER,
      imageUrl: 'https://cdn/castle.png', unitLabel: 'bottle',
      unitsPerPack: 24, packLabel: 'case',
      onHand: 30, lowStockThreshold: 6, status: 'in_stock',
      merchantId: bar, merchantName: 'Main Bar',
    });
  });

  it('nulls the optional fields rather than dropping them', async () => {
    const { eventId, token } = await seedFloor();
    const bar = await seedStall(eventId, 'Main Bar');
    await allocate(eventId, bar, await seedProduct(eventId, 'Ice'), 9);

    const tile = (await get(token)).body.data.products[0];

    // StockProduct.fromJson reads these as nullable — an absent key and a null
    // both parse, but a null is the honest "this product has none".
    expect(tile).toMatchObject({
      barcode: null, imageUrl: null, unitsPerPack: null,
      packLabel: null, lowStockThreshold: null, unitLabel: 'unit',
    });
  });

  it('leaves out a product no stall has stocked', async () => {
    const { eventId, token } = await seedFloor();
    const bar = await seedStall(eventId, 'Main Bar');
    const beer = await seedProduct(eventId, 'Castle Lite 330ml');
    await seedProduct(eventId, 'Quarter Chicken', { category: ProductCategory.FOOD });
    await allocate(eventId, bar, beer, 12);

    const res = await get(token);

    // Absent, not present at zero: addItem would refuse it with "product not
    // sold at that stall", so a tile for it is a tile that cannot be tapped.
    expect(res.body.data.products.map((p: any) => p.productId)).toEqual([beer]);
  });

  it('leaves out an inactive product even where it is still allocated', async () => {
    const { eventId, token } = await seedFloor();
    const bar = await seedStall(eventId, 'Main Bar');
    const retired = await seedProduct(eventId, 'Last Season Cider', { active: false });
    await allocate(eventId, bar, retired, 8);

    expect((await get(token)).body.data.products).toEqual([]);
  });

  it('leaves out a suspended stall', async () => {
    const { eventId, token } = await seedFloor();
    const closed = await seedStall(eventId, 'Closed Bar', 'suspended');
    await allocate(eventId, closed, await seedProduct(eventId, 'Castle Lite 330ml'), 12);

    // A suspended stall cannot log its own till in (merchantAuth) or take a
    // charge (MerchantService.charge). Offering its stock to the floor would
    // be the one way stock still left a stall the organizer has closed.
    expect((await get(token)).body.data.products).toEqual([]);
  });

  it("leaves out another event's stalls entirely", async () => {
    const { eventId, token } = await seedFloor();
    const mine = await seedStall(eventId, 'Main Bar');
    const beer = await seedProduct(eventId, 'Castle Lite 330ml');
    await allocate(eventId, mine, beer, 12);

    const other = await seedFloor();
    const theirs = await seedStall(other.eventId, 'Their Bar');
    await allocate(other.eventId, theirs, await seedProduct(other.eventId, 'Their Beer'), 50);

    const res = await get(token);

    expect(res.body.data.products.map((p: any) => p.productId)).toEqual([beer]);
  });

  it('returns an empty list at an event with no stock yet, not an error', async () => {
    const { token } = await seedFloor();
    const res = await get(token);
    expect(res.status).toBe(200);
    expect(res.body.data.products).toEqual([]);
  });
});

/**
 * The same gates every other waiter route stands behind. A catalogue is a read,
 * but it is a read of the organizer's whole event inventory — a fired waiter
 * holding a week-long token must not still be able to enumerate it.
 */
describe('the waiter product grid — authorisation, revocation and lifecycle', () => {
  it('401s without a waiter token', async () => {
    await seedFloor();
    expect((await request(app).get('/api/waiter/products')).status).toBe(401);
  });

  it('401s a cashier token — the scope claim is not interchangeable', async () => {
    await seedFloor();
    const cashier = jwt.sign({ scope: 'cashier', userType: 'cashier' }, JWT_SECRET);
    expect((await get(cashier)).status).toBe(401);
  });

  it('reads the permission set off the ROW, so an emptied token claim still serves', async () => {
    // authenticateWaiter re-derives permissions from the waiter row on every
    // request; the token's claim is the POS's rendering copy and authorizes
    // nothing. VIEW_EVENTS is part of the role floor, so a live waiter holds
    // it however stale the claim in their hand.
    const { token } = await seedFloor([]);
    const res = await get(token);
    expect(res.status).toBe(200);
  });

  it('401s a waiter deactivated AFTER they logged in', async () => {
    const { eventId, token, waiterId } = await seedFloor();
    const bar = await seedStall(eventId, 'Main Bar');
    await allocate(eventId, bar, await seedProduct(eventId, 'Castle Lite 330ml'), 12);
    // The organizer hits Disable. The token in their hand is untouched and
    // still cryptographically valid for another week.
    await Waiter.updateOne({ _id: waiterId }, { $set: { isActive: false } });

    const res = await get(token);

    // Refused at AUTHENTICATION now, not at event scope: authenticateWaiter
    // re-reads the row before any handler runs, so a fired waiter is signed
    // out rather than merely told they are off this event.
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/deactivated/i);
    expect(res.body.data).toBeUndefined();
  });

  it('401s a waiter whose row was deleted after login', async () => {
    const { eventId, token, waiterId } = await seedFloor();
    const bar = await seedStall(eventId, 'Main Bar');
    await allocate(eventId, bar, await seedProduct(eventId, 'Castle Lite 330ml'), 12);
    await Waiter.deleteOne({ _id: waiterId });

    const res = await get(token);

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/deactivated/i);
  });

  it('400s once the event is no longer published', async () => {
    const { token } = await seedFloor(WAITER_PERMISSIONS, { status: EventStatus.CANCELLED });
    const res = await get(token);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not published/i);
  });

  it('400s at an event that is not cashless', async () => {
    const { token } = await seedFloor(WAITER_PERMISSIONS, { cashless: false });
    const res = await get(token);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not cashless/i);
  });

  it('404s when the token names an event that no longer exists', async () => {
    const { eventId, token } = await seedFloor();
    await Event.deleteOne({ _id: eventId });

    const res = await get(token);

    expect(res.status).toBe(404);
    // The message matters: Express answers an unrouted path with a 404 too, so
    // a status-only assertion here would pass even with no route mounted.
    expect(res.body.message).toMatch(/event not found/i);
  });
});
