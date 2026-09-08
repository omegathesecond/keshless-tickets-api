/**
 * initiateDeltapayPurchase + finalizeDeltapaySale, using in-memory Mongo and a
 * module-level mock of DeltapayClient. Mirrors ticket.card.test.ts.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

// ── Mock DeltapayClient BEFORE importing TicketService ───────────────────────
// Every `new DeltapayClient()` in TicketService (static field) returns the same
// shared mock instance. classifySessionStatus stays real — it's pure logic.
const createSession = jest.fn();
const verifySession = jest.fn();

jest.mock('@services/payments/deltapay.client', () => ({
  classifySessionStatus: jest.requireActual('@services/payments/deltapay.client')
    .classifySessionStatus,
  DeltapayClient: jest
    .fn()
    .mockImplementation(() => ({ isConfigured: () => true, createSession, verifySession })),
  __mock: { createSession, verifySession },
}));

import { TicketService } from '@services/ticket.service';
import { PaymentConfigService } from '@services/paymentConfig.service';

beforeAll(async () => {
  await connectTestDb();
  process.env['DELTAPAY_RETURN_URL'] = 'https://carrot.test/api/public/purchase/deltapay/return';
});

beforeEach(async () => {
  // deltapayEnabled must be true for initiate tests to pass the admin toggle check.
  // Re-seeded each time because clearTestDb() wipes the config document.
  await PaymentConfigService.update({
    deltapayEnabled: true,
    platformFeePercent: 0,
    deltapayServiceFee: 0,
  });
});

afterEach(async () => {
  await clearTestDb();
  createSession.mockReset();
  verifySession.mockReset();
});

afterAll(async () => {
  await disconnectTestDb();
});

// ── Seed helpers ─────────────────────────────────────────────────────────────
async function seedPublishedEvent() {
  const vendorId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'DeltaPay Test Concert',
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

describe('initiateDeltapayPurchase', () => {
  it('creates a PENDING sale, reserves inventory and returns the checkout URL', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    createSession.mockResolvedValue({
      checkoutSessionId: 'sess_1',
      checkoutUrl: 'https://checkout.deltacrypt.net/hosted-checkout/?checkout_session_id=sess_1',
      expiresAt: '2026-01-01T12:10:00Z',
    });

    const r = await TicketService.initiateDeltapayPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26878422613',
    } as any);

    expect(r.checkoutSessionId).toBe('sess_1');
    expect(r.checkoutUrl).toContain('checkout.deltacrypt.net');

    // Sale must be PENDING with no tickets minted
    const sale = await TicketSale.findOne({ deltapaySessionId: 'sess_1' });
    expect(sale).not.toBeNull();
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(sale!.ticketIds.length).toBe(0);
    expect(sale!.paymentMethod).toBe(PaymentMethod.DELTAPAY);

    // Inventory held
    const updatedEvent = await Event.findById(eventId);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(1);
    expect(updatedEvent!.ticketTypes[0]!.available).toBe(9);
  });

  it('passes the buyer phone upfront as an E.164 payer identifier', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    createSession.mockResolvedValue({ checkoutSessionId: 's', checkoutUrl: 'https://c' });

    await TicketService.initiateDeltapayPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '78422613', // bare local number — must be normalised
    } as any);

    const arg = createSession.mock.calls[0]![0];
    expect(arg.payerIdentifier).toBe('+26878422613');
    expect(arg.payerIdentifierType).toBe('phone_number');
    expect(arg.merchantReference).toBeDefined();
    expect(arg.returnUrl).toContain('/deltapay/return');
  });

  it('releases the reservation and FAILS the sale when createSession throws', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    createSession.mockRejectedValue(new Error('DeltaPay down'));

    await expect(
      TicketService.initiateDeltapayPurchase({
        eventId,
        items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
        customerPhone: '+26878422613',
      } as any)
    ).rejects.toThrow('DeltaPay down');

    const sale = await TicketSale.findOne({ paymentMethod: PaymentMethod.DELTAPAY });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);

    const updatedEvent = await Event.findById(eventId);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(0); // released
  });

  it('throws when the deltapayEnabled toggle is off', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();
    await PaymentConfigService.update({ deltapayEnabled: false });

    await expect(
      TicketService.initiateDeltapayPurchase({
        eventId,
        items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
        customerPhone: '+26878422613',
      } as any)
    ).rejects.toThrow('DeltaPay is not available');
  });

  it('getDeltapaySaleBySessionId returns the sale by session id', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    createSession.mockResolvedValue({ checkoutSessionId: 'sess_lookup', checkoutUrl: 'https://c' });

    await TicketService.initiateDeltapayPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26878422613',
    } as any);

    const found = await TicketService.getDeltapaySaleBySessionId('sess_lookup');
    expect(found).not.toBeNull();
    expect(found!.deltapaySessionId).toBe('sess_lookup');
    expect(found!.paymentMethod).toBe(PaymentMethod.DELTAPAY);
  });
});

// ── Helper: seed a PENDING DeltaPay sale with a reservation ─────────────────
async function seedPendingDeltapaySale(overrides?: { paymentStatus?: PaymentStatus }) {
  const vendorId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'Finalize DeltaPay Concert',
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
    paymentMethod: PaymentMethod.DELTAPAY,
    paymentStatus: overrides?.paymentStatus ?? PaymentStatus.PENDING,
    deltapaySessionId: 'sess_finalize',
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
    expiresAt: new Date(Date.now() + 12 * 60_000),
    status: 'held',
  });

  return { event, sale, ticketTypeId, vendorId };
}

describe('finalizeDeltapaySale', () => {
  it('returns pending while the session is still processing', async () => {
    await seedPendingDeltapaySale();

    verifySession.mockResolvedValue({ status: 'processing', amount: 50 });

    const result = await TicketService.finalizeDeltapaySale('sess_finalize');
    expect(result.status).toBe('pending');
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it('treats an UNKNOWN status as pending — never mints', async () => {
    await seedPendingDeltapaySale();

    verifySession.mockResolvedValue({ status: 'something_new', amount: 50 });

    const result = await TicketService.finalizeDeltapaySale('sess_finalize');
    expect(result.status).toBe('pending');
    expect(await Ticket.countDocuments({})).toBe(0);

    // Hold must be left intact so the reservation sweep can resolve it.
    const { event } = { event: await Event.findOne({ name: 'Finalize DeltaPay Concert' }) };
    expect(event!.ticketTypes[0]!.reserved).toBe(1);
  });

  it.each(['failed', 'expired', 'cancelled'])(
    'releases the hold and FAILS the sale on %s',
    async (status) => {
      const { event } = await seedPendingDeltapaySale();

      verifySession.mockResolvedValue({ status, amount: 50 });

      const result = await TicketService.finalizeDeltapaySale('sess_finalize');
      expect(result.status).toBe('failed');

      const sale = await TicketSale.findOne({ deltapaySessionId: 'sess_finalize' });
      expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);

      const updatedEvent = await Event.findById(event._id);
      expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(0);
      expect(await Ticket.countDocuments({})).toBe(0);
    }
  );

  it('mints tickets and completes the sale on succeeded', async () => {
    const { event } = await seedPendingDeltapaySale();

    verifySession.mockResolvedValue({ status: 'succeeded', amount: 50 });

    const result = await TicketService.finalizeDeltapaySale('sess_finalize');
    expect(result.status).toBe('completed');

    const sale = await TicketSale.findOne({ deltapaySessionId: 'sess_finalize' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(sale!.ticketIds.length).toBe(1);
    expect(await Ticket.countDocuments({})).toBe(1);

    const updatedEvent = await Event.findById(event._id);
    expect(updatedEvent!.ticketTypes[0]!.sold).toBe(1);
  });

  it('refuses to mint when the confirmed amount does not match what we charged', async () => {
    const { event } = await seedPendingDeltapaySale();

    // succeeded, but for E10 instead of the E50 we charged
    verifySession.mockResolvedValue({ status: 'succeeded', amount: 10 });

    const result = await TicketService.finalizeDeltapaySale('sess_finalize');
    expect(result.status).toBe('failed');

    const sale = await TicketSale.findOne({ deltapaySessionId: 'sess_finalize' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(await Ticket.countDocuments({})).toBe(0);

    const updatedEvent = await Event.findById(event._id);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(0);
  });

  it('refuses to mint when the provider reports no amount at all', async () => {
    await seedPendingDeltapaySale();

    verifySession.mockResolvedValue({ status: 'succeeded' });

    const result = await TicketService.finalizeDeltapaySale('sess_finalize');
    expect(result.status).toBe('failed');
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it('is idempotent — an already-COMPLETED sale never re-verifies or re-mints', async () => {
    await seedPendingDeltapaySale({ paymentStatus: PaymentStatus.COMPLETED });

    const result = await TicketService.finalizeDeltapaySale('sess_finalize');
    expect(result.status).toBe('completed');
    expect(verifySession).not.toHaveBeenCalled();
    expect(await Ticket.countDocuments({})).toBe(0);
  });

  it('mints exactly once when the return, callback and poll all finalise concurrently', async () => {
    await seedPendingDeltapaySale();

    verifySession.mockResolvedValue({ status: 'succeeded', amount: 50 });

    const results = await Promise.all([
      TicketService.finalizeDeltapaySale('sess_finalize'),
      TicketService.finalizeDeltapaySale('sess_finalize'),
      TicketService.finalizeDeltapaySale('sess_finalize'),
    ]);

    expect(results.every(r => r.status === 'completed')).toBe(true);
    // The atomic CAS claim must keep this at exactly one ticket.
    expect(await Ticket.countDocuments({})).toBe(1);
  });

  it('throws when no sale matches the session id', async () => {
    await expect(TicketService.finalizeDeltapaySale('sess_unknown')).rejects.toThrow(/not found/i);
  });
});
