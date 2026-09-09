// Menu preorders over HTTP — the buyer's checkout (POST /api/public/events/
// :eventId/menu-orders) and the organizer's fulfilment PATCH
// (/api/tickets/menu-orders/:id).
//
// Invariants under test:
//  - a preorder can only be placed against a PUBLISHED event (the public menu
//    read already requires it; checkout must not be a way around that);
//  - known checkout refusals surface with a real 4xx/503, never a blanket 500;
//  - duplicate lines of one item are merged BEFORE the per-line cap applies,
//    so splitting a quantity across lines cannot defeat the cap;
//  - fulfilment only moves forward (new → preparing → ready → collected), any
//    non-terminal state can be cancelled, collected/cancelled are terminal,
//    and an UNPAID order cannot enter the kitchen.

import request from 'supertest';
import mongoose from 'mongoose';

const mockMomoInstance = {
  isConfigured: jest.fn(),
  requestToPay: jest.fn(),
  getStatus: jest.fn(),
};
jest.mock('@services/payments/mtnMomo.client', () => ({
  MtnMomoClient: jest.fn().mockImplementation(() => mockMomoInstance),
}));
jest.mock('@services/keshlessPayment.service');

import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Event } from '@models/event.model';
import { Buyer } from '@models/buyer.model';
import { MenuItem, MenuSection } from '@models/menuItem.model';
import { MenuOrder, MenuOrderFulfillmentStatus } from '@models/menuOrder.model';
import { KeshlessPaymentService } from '@services/keshlessPayment.service';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

const acceptPayment = KeshlessPaymentService.acceptPayment as jest.MockedFunction<typeof KeshlessPaymentService.acceptPayment>;

const VENDOR_A = '64c000000000000000000a01';
const BUYER_PHONE = '+26878422613';
const CARD = '1234567890123456';

const organizerToken = () => signVendorToken(VENDOR_A, { permissions: [TicketsPermission.MANAGE_MENU] });

async function eventWith(status: EventStatus, vendorId = VENDOR_A): Promise<string> {
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(vendorId), name: 'Menu Night', venue: 'V',
    eventDate: future, startTime: future, endTime: future, status,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  return event._id.toString();
}

async function menuItem(eventId: string, over: Record<string, unknown> = {}) {
  const item = await MenuItem.create({
    eventId, section: MenuSection.BAR, category: 'Beer', name: 'Lager', price: 2500, ...over,
  });
  return item._id.toString();
}

async function seedBuyer() {
  // avatarUrl by default — see memory: photoless Buyer fixtures trip the
  // profile-photo gate on social routes and mask the assertion under test.
  return Buyer.create({ phone: BUYER_PHONE, password: 'password123', name: 'Sipho', avatarUrl: 'https://cdn.test/avatar.jpg' });
}

function keshlessOk() {
  acceptPayment.mockResolvedValue({
    status: 'completed', transactionId: 'KTX-1', amount: 25, feeAmount: 0, totalAmount: 25, vendorReceived: 25,
  });
}

async function paidOrder(eventId: string, buyerId: mongoose.Types.ObjectId, over: Record<string, unknown> = {}) {
  return MenuOrder.create({
    orderId: `MENU-T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    eventId, vendorId: new mongoose.Types.ObjectId(VENDOR_A), buyerId,
    items: [{ menuItemId: new mongoose.Types.ObjectId(), name: 'Lager', unitPrice: 2500, quantity: 1, lineTotal: 2500 }],
    subtotal: 2500, serviceFeeAmount: 200, amountCharged: 2700,
    paymentMethod: PaymentMethod.KESHLESS_WALLET, paymentStatus: PaymentStatus.COMPLETED,
    fulfillmentStatus: MenuOrderFulfillmentStatus.NEW,
    ...over,
  });
}

beforeAll(connectTestDb);
afterEach(async () => { await clearTestDb(); jest.clearAllMocks(); });
afterAll(disconnectTestDb);

describe('POST /api/public/events/:eventId/menu-orders — placing a preorder', () => {
  it('refuses a preorder on a DRAFT event with 404 and writes no MenuOrder', async () => {
    await seedBuyer();
    const eventId = await eventWith(EventStatus.DRAFT);
    const itemId = await menuItem(eventId);
    keshlessOk();

    const res = await request(app)
      .post(`/api/public/events/${eventId}/menu-orders`)
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .send({ items: [{ menuItemId: itemId, quantity: 1 }], paymentMethod: PaymentMethod.KESHLESS_WALLET, keshlessCardNumber: CARD });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Event not found or not open for orders');
    expect(await MenuOrder.countDocuments({})).toBe(0);
    expect(acceptPayment).not.toHaveBeenCalled();
  });

  it('refuses a MoMo preorder on a PENDING_APPROVAL event without calling MTN', async () => {
    await seedBuyer();
    const eventId = await eventWith(EventStatus.PENDING_APPROVAL);
    const itemId = await menuItem(eventId);
    mockMomoInstance.isConfigured.mockReturnValue(true);

    const res = await request(app)
      .post(`/api/public/events/${eventId}/menu-orders`)
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .send({ items: [{ menuItemId: itemId, quantity: 1 }], paymentMethod: PaymentMethod.MTN_MOMO, momoPhone: '76111111' });

    expect(res.status).toBe(404);
    expect(await MenuOrder.countDocuments({})).toBe(0);
    expect(mockMomoInstance.requestToPay).not.toHaveBeenCalled();
  });

  it('places a Keshless preorder on a PUBLISHED event', async () => {
    await seedBuyer();
    const eventId = await eventWith(EventStatus.PUBLISHED);
    const itemId = await menuItem(eventId);
    keshlessOk();

    const res = await request(app)
      .post(`/api/public/events/${eventId}/menu-orders`)
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .send({ items: [{ menuItemId: itemId, quantity: 1 }], paymentMethod: PaymentMethod.KESHLESS_WALLET, keshlessCardNumber: CARD });

    expect(res.status).toBe(201);
    expect(res.body.data.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(await MenuOrder.countDocuments({ paymentStatus: PaymentStatus.COMPLETED })).toBe(1);
  });

  it('returns 503 when MTN MoMo is not available, not a 500', async () => {
    await seedBuyer();
    const eventId = await eventWith(EventStatus.PUBLISHED);
    const itemId = await menuItem(eventId);
    mockMomoInstance.isConfigured.mockReturnValue(false);

    const res = await request(app)
      .post(`/api/public/events/${eventId}/menu-orders`)
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .send({ items: [{ menuItemId: itemId, quantity: 1 }], paymentMethod: PaymentMethod.MTN_MOMO, momoPhone: '76111111' });

    expect(res.status).toBe(503);
    expect(res.body.message).toBe('MTN MoMo is not available');
  });

  it('returns 400 for a malformed menuItemId (Mongoose CastError), not a 500', async () => {
    await seedBuyer();
    const eventId = await eventWith(EventStatus.PUBLISHED);
    keshlessOk();

    const res = await request(app)
      .post(`/api/public/events/${eventId}/menu-orders`)
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .send({ items: [{ menuItemId: 'not-an-object-id', quantity: 1 }], paymentMethod: PaymentMethod.KESHLESS_WALLET, keshlessCardNumber: CARD });

    expect(res.status).toBe(400);
    expect(await MenuOrder.countDocuments({})).toBe(0);
    expect(acceptPayment).not.toHaveBeenCalled();
  });

  it('returns 409 when a menu item is no longer available', async () => {
    await seedBuyer();
    const eventId = await eventWith(EventStatus.PUBLISHED);
    const itemId = await menuItem(eventId, { active: false });
    keshlessOk();

    const res = await request(app)
      .post(`/api/public/events/${eventId}/menu-orders`)
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .send({ items: [{ menuItemId: itemId, quantity: 1 }], paymentMethod: PaymentMethod.KESHLESS_WALLET, keshlessCardNumber: CARD });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/no longer available/);
    expect(acceptPayment).not.toHaveBeenCalled();
  });

  it('returns 400 when a PIN is required for an E50+ order', async () => {
    await seedBuyer();
    const eventId = await eventWith(EventStatus.PUBLISHED);
    const itemId = await menuItem(eventId, { price: 6000 }); // E60
    keshlessOk();

    const res = await request(app)
      .post(`/api/public/events/${eventId}/menu-orders`)
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .send({ items: [{ menuItemId: itemId, quantity: 1 }], paymentMethod: PaymentMethod.KESHLESS_WALLET, keshlessCardNumber: CARD });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/PIN required/);
    expect(acceptPayment).not.toHaveBeenCalled();
  });

  it('merges duplicate lines of the same item into one line with the summed quantity', async () => {
    await seedBuyer();
    const eventId = await eventWith(EventStatus.PUBLISHED);
    const itemId = await menuItem(eventId, { price: 100 }); // E1 each, stays under the PIN threshold
    keshlessOk();

    const res = await request(app)
      .post(`/api/public/events/${eventId}/menu-orders`)
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .send({
        items: [{ menuItemId: itemId, quantity: 2 }, { menuItemId: itemId, quantity: 3 }],
        paymentMethod: PaymentMethod.KESHLESS_WALLET, keshlessCardNumber: CARD,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].quantity).toBe(5);
    expect(res.body.data.items[0].lineTotal).toBe(500);
    expect(res.body.data.subtotal).toBe(500);
  });

  it('rejects a merged quantity over the per-line cap with 400, even though each line is under it', async () => {
    await seedBuyer();
    const eventId = await eventWith(EventStatus.PUBLISHED);
    const itemId = await menuItem(eventId, { price: 100 });
    keshlessOk();

    const res = await request(app)
      .post(`/api/public/events/${eventId}/menu-orders`)
      .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
      .send({
        items: [{ menuItemId: itemId, quantity: 30 }, { menuItemId: itemId, quantity: 30 }],
        paymentMethod: PaymentMethod.KESHLESS_WALLET, keshlessCardNumber: CARD,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/50/);
    expect(await MenuOrder.countDocuments({})).toBe(0);
    expect(acceptPayment).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/tickets/menu-orders/:id — fulfilment transitions', () => {
  let eventId: string;
  let buyerId: mongoose.Types.ObjectId;

  beforeEach(async () => {
    const buyer = await seedBuyer();
    buyerId = buyer._id as mongoose.Types.ObjectId;
    eventId = await eventWith(EventStatus.PUBLISHED);
  });

  const patch = (id: string, fulfillmentStatus: string) =>
    request(app).patch(`/api/tickets/menu-orders/${id}`)
      .set('Authorization', `Bearer ${organizerToken()}`)
      .send({ fulfillmentStatus });

  it('walks a paid order forward: new → preparing → ready → collected', async () => {
    const order = await paidOrder(eventId, buyerId);
    for (const next of ['preparing', 'ready', 'collected']) {
      const res = await patch(order._id.toString(), next);
      expect(res.status).toBe(200);
      expect(res.body.data.fulfillmentStatus).toBe(next);
    }
  });

  it('refuses a backwards move (ready → new) with 409 naming the current state', async () => {
    const order = await paidOrder(eventId, buyerId, { fulfillmentStatus: MenuOrderFulfillmentStatus.READY });

    const res = await patch(order._id.toString(), 'new');

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/ready/);
    expect((await MenuOrder.findById(order._id))!.fulfillmentStatus).toBe(MenuOrderFulfillmentStatus.READY);
  });

  it('refuses skipping ahead (new → ready)', async () => {
    const order = await paidOrder(eventId, buyerId);

    const res = await patch(order._id.toString(), 'ready');

    expect(res.status).toBe(409);
    expect((await MenuOrder.findById(order._id))!.fulfillmentStatus).toBe(MenuOrderFulfillmentStatus.NEW);
  });

  it('collected is terminal — it cannot be reopened', async () => {
    const order = await paidOrder(eventId, buyerId, { fulfillmentStatus: MenuOrderFulfillmentStatus.COLLECTED });

    for (const next of ['new', 'preparing', 'ready', 'cancelled']) {
      const res = await patch(order._id.toString(), next);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/collected/);
    }
    expect((await MenuOrder.findById(order._id))!.fulfillmentStatus).toBe(MenuOrderFulfillmentStatus.COLLECTED);
  });

  it('cancelled is terminal', async () => {
    const order = await paidOrder(eventId, buyerId, { fulfillmentStatus: MenuOrderFulfillmentStatus.CANCELLED });

    const res = await patch(order._id.toString(), 'new');

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/cancelled/);
  });

  it('an UNPAID order cannot be moved into preparing', async () => {
    const order = await paidOrder(eventId, buyerId, { paymentStatus: PaymentStatus.PENDING });

    const res = await patch(order._id.toString(), 'preparing');

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/pending/i);
    expect((await MenuOrder.findById(order._id))!.fulfillmentStatus).toBe(MenuOrderFulfillmentStatus.NEW);
  });

  it('an UNPAID order can still be cancelled from new', async () => {
    const order = await paidOrder(eventId, buyerId, { paymentStatus: PaymentStatus.PENDING });

    const res = await patch(order._id.toString(), 'cancelled');

    expect(res.status).toBe(200);
    expect(res.body.data.fulfillmentStatus).toBe(MenuOrderFulfillmentStatus.CANCELLED);
  });

  it('any non-terminal state can be cancelled (ready → cancelled)', async () => {
    const order = await paidOrder(eventId, buyerId, { fulfillmentStatus: MenuOrderFulfillmentStatus.READY });

    const res = await patch(order._id.toString(), 'cancelled');

    expect(res.status).toBe(200);
    expect(res.body.data.fulfillmentStatus).toBe(MenuOrderFulfillmentStatus.CANCELLED);
  });
});

describe('POST /api/tickets/menu-orders/scan and /collect — QR collection scanner', () => {
  let eventId: string;
  let buyerId: mongoose.Types.ObjectId;

  beforeEach(async () => {
    const buyer = await seedBuyer();
    buyerId = buyer._id as mongoose.Types.ObjectId;
    eventId = await eventWith(EventStatus.PUBLISHED);
  });

  const scan = (orderId: string, token = organizerToken()) =>
    request(app).post('/api/tickets/menu-orders/scan')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId });

  const collect = (orderId: string, token = organizerToken()) =>
    request(app).post('/api/tickets/menu-orders/collect')
      .set('Authorization', `Bearer ${token}`)
      .send({ orderId });

  it('finds a paid order by its human-readable orderId (the QR payload)', async () => {
    const order = await paidOrder(eventId, buyerId, { fulfillmentStatus: MenuOrderFulfillmentStatus.READY });

    const res = await scan(order.orderId);

    expect(res.status).toBe(200);
    expect(res.body.data.orderId).toBe(order.orderId);
    expect(res.body.data.fulfillmentStatus).toBe(MenuOrderFulfillmentStatus.READY);
  });

  it('returns 404 for an unknown code, never leaking whether it is malformed or someone else\'s', async () => {
    const res = await scan('MENU-DOES-NOT-EXIST');
    expect(res.status).toBe(404);
  });

  it('404s a real order that belongs to a different vendor, same as not-found', async () => {
    const otherEventId = await eventWith(EventStatus.PUBLISHED, '64c000000000000000000b02');
    const order = await MenuOrder.create({
      orderId: 'MENU-OTHER-VENDOR',
      eventId: otherEventId, vendorId: new mongoose.Types.ObjectId('64c000000000000000000b02'), buyerId,
      items: [{ menuItemId: new mongoose.Types.ObjectId(), name: 'Lager', unitPrice: 2500, quantity: 1, lineTotal: 2500 }],
      subtotal: 2500, serviceFeeAmount: 200, amountCharged: 2700,
      paymentMethod: PaymentMethod.KESHLESS_WALLET, paymentStatus: PaymentStatus.COMPLETED,
    });

    const res = await scan(order.orderId);

    expect(res.status).toBe(404);
  });

  it('collects a READY order and stamps collectedAt', async () => {
    const order = await paidOrder(eventId, buyerId, { fulfillmentStatus: MenuOrderFulfillmentStatus.READY });

    const res = await collect(order.orderId);

    expect(res.status).toBe(200);
    expect(res.body.data.fulfillmentStatus).toBe(MenuOrderFulfillmentStatus.COLLECTED);
    expect(res.body.data.collectedAt).toBeTruthy();
    expect((await MenuOrder.findById(order._id))!.fulfillmentStatus).toBe(MenuOrderFulfillmentStatus.COLLECTED);
  });

  it('re-scanning an already-collected order refuses with 409 and the collection time, not a silent success', async () => {
    const collectedAt = new Date('2026-01-01T10:00:00Z');
    const order = await paidOrder(eventId, buyerId, { fulfillmentStatus: MenuOrderFulfillmentStatus.COLLECTED, collectedAt });

    const res = await collect(order.orderId);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already collected/i);
    expect(res.body.message).toContain(collectedAt.toLocaleString());
  });

  it('refuses to collect an order that has not reached ready (new → collected skips ahead)', async () => {
    const order = await paidOrder(eventId, buyerId);

    const res = await collect(order.orderId);

    expect(res.status).toBe(409);
    expect((await MenuOrder.findById(order._id))!.fulfillmentStatus).toBe(MenuOrderFulfillmentStatus.NEW);
  });

  it('a scan that races a second scan collects exactly once (no double-redemption)', async () => {
    const order = await paidOrder(eventId, buyerId, { fulfillmentStatus: MenuOrderFulfillmentStatus.READY });

    const [first, second] = await Promise.all([collect(order.orderId), collect(order.orderId)]);
    const statuses = [first.status, second.status].sort();

    expect(statuses).toEqual([200, 409]);
  });
});
