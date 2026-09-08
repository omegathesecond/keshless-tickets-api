/**
 * initiateYocoPurchase + finalizeYocoSale, using in-memory Mongo and a
 * module-level mock of YocoClient. Mirrors ticket.deltapay.test.ts.
 *
 * The structural difference from the Peach/DeltaPay suites: Yoco has NO
 * status-query endpoint, so finalizeYocoSale is handed the ALREADY-VERIFIED
 * webhook payload rather than calling out to the provider. Every guard that
 * used to run against a provider response now runs against that payload.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

// ── Mock YocoClient BEFORE importing TicketService ──────────────────────────
// classifyEventType and toCents stay real — they are pure logic and are exactly
// the parts whose behaviour these tests depend on.
const createCheckout = jest.fn();

jest.mock('@services/payments/yoco.client', () => ({
  classifyEventType: jest.requireActual('@services/payments/yoco.client').classifyEventType,
  toCents: jest.requireActual('@services/payments/yoco.client').toCents,
  YocoClient: jest.fn().mockImplementation(() => ({ isConfigured: () => true, createCheckout })),
}));

import { TicketService } from '@services/ticket.service';
import { PaymentConfigService } from '@services/paymentConfig.service';

beforeAll(async () => {
  await connectTestDb();
  process.env['YOCO_RETURN_URL'] = 'https://carrot.test/api/public/purchase/yoco/return';
});

beforeEach(async () => {
  await PaymentConfigService.update({
    yocoEnabled: true,
    platformFeePercent: 0,
    yocoServiceFee: 0,
  });
});

afterEach(async () => {
  await clearTestDb();
  createCheckout.mockReset();
});

afterAll(async () => {
  await disconnectTestDb();
});

// ── Seed helpers ────────────────────────────────────────────────────────────
async function seedPublishedEvent() {
  const vendorId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'Yoco Test Concert',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });

  const ticketTypeId = event.ticketTypes[0]!._id!.toString();
  return { event, ticketTypeId, vendorId, eventId: event._id.toString() };
}

describe('initiateYocoPurchase', () => {
  it('creates a PENDING sale, reserves inventory and returns the redirect URL', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    createCheckout.mockResolvedValue({
      id: 'ch_1',
      redirectUrl: 'https://c.yoco.com/checkout/ch_1',
      status: 'created',
    });

    const r = await TicketService.initiateYocoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26878422613',
    } as any);

    expect(r.checkoutId).toBe('ch_1');
    expect(r.redirectUrl).toBe('https://c.yoco.com/checkout/ch_1');

    const sale = await TicketSale.findOne({ yocoCheckoutId: 'ch_1' });
    expect(sale).not.toBeNull();
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(sale!.ticketIds.length).toBe(0);
    expect(sale!.paymentMethod).toBe(PaymentMethod.YOCO);

    const updatedEvent = await Event.findById(eventId);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(1);
    expect(updatedEvent!.ticketTypes[0]!.available).toBe(9);
  });

  it('sends ZAR, our sale ref and all three return URLs to Yoco', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();
    createCheckout.mockResolvedValue({ id: 'ch_2', redirectUrl: 'https://c' });

    await TicketService.initiateYocoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26878422613',
    } as any);

    const arg = createCheckout.mock.calls[0]![0];
    expect(arg.currency).toBe('ZAR');
    expect(arg.amount).toBe(100); // rands in; the client converts to cents
    expect(arg.successUrl).toContain('/yoco/return');
    expect(arg.cancelUrl).toContain('/yoco/return');
    expect(arg.failureUrl).toContain('/yoco/return');
    expect(arg.metadata.saleRef).toBeDefined();
    expect(arg.externalId).toBe(arg.metadata.saleRef);
    // Idempotency key must be stable per sale so a retried initiate cannot
    // create a second checkout the buyer could pay twice.
    expect(arg.idempotencyKey).toBeDefined();
  });

  it('releases the reservation and FAILS the sale when createCheckout throws', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();
    createCheckout.mockRejectedValue(new Error('Yoco down'));

    await expect(
      TicketService.initiateYocoPurchase({
        eventId, items: [{ ticketTypeId: ticketTypeId, quantity: 1 }], customerPhone: '+26878422613',
      } as any)
    ).rejects.toThrow('Yoco down');

    const sale = await TicketSale.findOne({ paymentMethod: PaymentMethod.YOCO });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);

    const updatedEvent = await Event.findById(eventId);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(0);
  });

  it('throws when the yocoEnabled toggle is off', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();
    await PaymentConfigService.update({ yocoEnabled: false });

    await expect(
      TicketService.initiateYocoPurchase({
        eventId, items: [{ ticketTypeId: ticketTypeId, quantity: 1 }], customerPhone: '+26878422613',
      } as any)
    ).rejects.toThrow('Yoco is not available');
  });

  it('getYocoSaleByCheckoutId returns the sale by checkout id', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();
    createCheckout.mockResolvedValue({ id: 'ch_lookup', redirectUrl: 'https://c' });

    await TicketService.initiateYocoPurchase({
      eventId, items: [{ ticketTypeId: ticketTypeId, quantity: 1 }], customerPhone: '+26878422613',
    } as any);

    const found = await TicketService.getYocoSaleByCheckoutId('ch_lookup');
    expect(found).not.toBeNull();
    expect(found!.yocoCheckoutId).toBe('ch_lookup');
    expect(found!.paymentMethod).toBe(PaymentMethod.YOCO);
  });
});

// ── Helper: seed a PENDING Yoco sale with a reservation ────────────────────
async function seedPendingYocoSale(overrides?: { paymentStatus?: PaymentStatus }) {
  const vendorId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'Finalize Yoco Concert',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [{ name: 'General', price: 50, quantity: 10, sold: 0, reserved: 1 }],
  });

  const ticketTypeId = event.ticketTypes[0]!._id!.toString();

  const sale = await TicketSale.create({
    eventId: event._id,
    vendorId,
    ticketIds: [],
    quantity: 1,
    // Composition snapshot the finalizer mints from — see TicketSale.lines.
    lines: [{ ticketTypeId, ticketTypeName: 'General', unitPrice: 50, quantity: 1 }],
    customerName: 'Test Buyer',
    customerPhone: '+26878422613',
    totalAmount: 50,
    amountCharged: 50,
    paymentMethod: PaymentMethod.YOCO,
    paymentStatus: overrides?.paymentStatus ?? PaymentStatus.PENDING,
    yocoCheckoutId: 'ch_finalize',
    soldBy: vendorId,
    soldByType: 'Vendor',
    channel: 'online',
    faceAmount: 50,
    platformFeeAmount: 0,
    organizerProceeds: 50,
    resellerCommission: 0,
    fundsCustody: 'carrot',
    soldAt: new Date(),
  });

  const { TicketReservation } = await import('@models/ticketReservation.model');
  await TicketReservation.create({
    eventId: event._id,
    lines: [{ ticketTypeId, quantity: 1 }],
    saleId: sale._id.toString(),
    expiresAt: new Date(Date.now() + 15 * 60_000),
    status: 'held',
  });

  return { event, sale, ticketTypeId, vendorId };
}

/** A verified payment.succeeded payload for the seeded E50 sale. */
const paidEvent = { type: 'payment.succeeded', amountCents: 5000, currency: 'ZAR' };

describe('finalizeYocoSale', () => {
  it('mints tickets and completes the sale on payment.succeeded', async () => {
    const { event } = await seedPendingYocoSale();

    const result = await TicketService.finalizeYocoSale('ch_finalize', paidEvent);
    expect(result.status).toBe('completed');

    const sale = await TicketSale.findOne({ yocoCheckoutId: 'ch_finalize' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(sale!.ticketIds.length).toBe(1);
    expect(await Ticket.countDocuments({})).toBe(1);

    const updatedEvent = await Event.findById(event._id);
    expect(updatedEvent!.ticketTypes[0]!.sold).toBe(1);
  });

  it('releases the hold and FAILS the sale on payment.failed', async () => {
    const { event } = await seedPendingYocoSale();

    const result = await TicketService.finalizeYocoSale('ch_finalize', {
      type: 'payment.failed', amountCents: 5000, currency: 'ZAR',
    });
    expect(result.status).toBe('failed');

    const sale = await TicketSale.findOne({ yocoCheckoutId: 'ch_finalize' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);

    const updatedEvent = await Event.findById(event._id);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(0);
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it('treats an UNKNOWN event type as pending — never mints, keeps the hold', async () => {
    const { event } = await seedPendingYocoSale();

    const result = await TicketService.finalizeYocoSale('ch_finalize', {
      type: 'refund.succeeded', amountCents: 5000, currency: 'ZAR',
    });
    expect(result.status).toBe('pending');
    expect(await Ticket.countDocuments({})).toBe(0);

    const updatedEvent = await Event.findById(event._id);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(1);
  });

  it('refuses to mint when the paid amount does not match what we charged', async () => {
    const { event } = await seedPendingYocoSale();

    // succeeded, but for R10 instead of the E50 we charged
    const result = await TicketService.finalizeYocoSale('ch_finalize', {
      type: 'payment.succeeded', amountCents: 1000, currency: 'ZAR',
    });
    expect(result.status).toBe('failed');

    const sale = await TicketSale.findOne({ yocoCheckoutId: 'ch_finalize' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(await Ticket.countDocuments({})).toBe(0);

    const updatedEvent = await Event.findById(event._id);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(0);
  });

  it('refuses to mint when the paid currency is not the settlement currency', async () => {
    await seedPendingYocoSale();

    const result = await TicketService.finalizeYocoSale('ch_finalize', {
      type: 'payment.succeeded', amountCents: 5000, currency: 'USD',
    });
    expect(result.status).toBe('failed');
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it('refuses to mint when the payload carries no usable amount', async () => {
    await seedPendingYocoSale();

    const result = await TicketService.finalizeYocoSale('ch_finalize', {
      type: 'payment.succeeded', amountCents: NaN, currency: 'ZAR',
    });
    expect(result.status).toBe('failed');
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it('is idempotent — an already-COMPLETED sale never re-mints', async () => {
    await seedPendingYocoSale({ paymentStatus: PaymentStatus.COMPLETED });

    const result = await TicketService.finalizeYocoSale('ch_finalize', paidEvent);
    expect(result.status).toBe('completed');
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it('mints exactly once when a retried webhook and the poll finalise concurrently', async () => {
    await seedPendingYocoSale();

    const results = await Promise.all([
      TicketService.finalizeYocoSale('ch_finalize', paidEvent),
      TicketService.finalizeYocoSale('ch_finalize', paidEvent),
      TicketService.finalizeYocoSale('ch_finalize', paidEvent),
    ]);

    expect(results.every(r => r.status === 'completed')).toBe(true);
    expect(await Ticket.countDocuments({})).toBe(1);
  });

  it('throws when no sale matches the checkout id', async () => {
    await expect(TicketService.finalizeYocoSale('ch_unknown', paidEvent)).rejects.toThrow(/not found/i);
  });
});
