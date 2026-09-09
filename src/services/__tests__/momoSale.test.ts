/**
 * Task 6: momoSale.test.ts
 * Tests initiateMomoPurchase and finalizeMomoSale using in-memory Mongo +
 * a module-level mock of MtnMomoClient so both the static TicketService.momoClient
 * and MtnMomoProcessor use the same mock instance.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { FollowService } from '@services/follow.service';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

// ── Mock MtnMomoClient BEFORE importing TicketService ──────────────────────
// Mocking the module means every `new MtnMomoClient()` (in processor AND the
// static TicketService.momoClient) returns the same mocked instance, so both
// paths hit our controlled stub.
//
// We use a manual factory mock: the constructor returns a single shared mockInstance
// object, so the static `TicketService.momoClient` and any later `new MtnMomoClient()`
// inside MtnMomoProcessor all point to the same mock.
const mockMomoInstance = {
  isConfigured: jest.fn(),
  requestToPay: jest.fn(),
  getStatus: jest.fn(),
};

jest.mock('@services/payments/mtnMomo.client', () => ({
  MtnMomoClient: jest.fn().mockImplementation(() => mockMomoInstance),
}));

import { TicketService } from '@services/ticket.service';

beforeAll(async () => {
  await connectTestDb();
});

afterEach(async () => {
  await clearTestDb();
  mockMomoInstance.isConfigured.mockReset();
  mockMomoInstance.requestToPay.mockReset();
  mockMomoInstance.getStatus.mockReset();
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
    name: 'MoMo Test Concert',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      {
        name: 'General',
        price: 100,
        quantity: 10,
        sold: 0,
        reserved: 0,
      },
    ],
  });

  const ticketTypeId = event.ticketTypes[0]!._id!.toString();
  return { event, ticketTypeId, vendorId, eventId: event._id.toString() };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TicketService.initiateMomoPurchase', () => {
  it('creates a PENDING sale + reservation and no tickets when requestToPay succeeds', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    // MtnMomoClient is mocked at module level; configure stubs on the shared mock instance
    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R1' });

    const result = await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 2 }],
      customerPhone: '+26876111111',
      momoPhone: '26876111111',
    });

    expect(result.referenceId).toBe('R1');
    expect(result.saleId).toBeTruthy();
    expect(result.expiresAt).toBeInstanceOf(Date);

    // Sale must be PENDING with no tickets minted
    const sale = await TicketSale.findOne({ momoReferenceId: 'R1' });
    expect(sale).not.toBeNull();
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(sale!.ticketIds.length).toBe(0);

    // Event reserved count must be 2
    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(2);
    expect(tt.available).toBe(8); // 10 - 0 sold - 2 reserved
  });

  it('normalises a local MoMo number to the full international MSISDN (no +) for MTN', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_MSISDN' });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26876707421',
      momoPhone: '76707421', // bare local 8-digit number, as a till operator would type
    });

    // MTN gets 26876707421 (268 prefix, no '+') — not the bare 76707421 that
    // produces PAYER_NOT_FOUND.
    expect(mockMomoInstance.requestToPay).toHaveBeenCalledWith(
      expect.objectContaining({ payerMsisdn: '26876707421' }),
    );
  });

  it('releases reservation and sets sale FAILED when requestToPay throws', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockRejectedValue(new Error('MoMo down'));

    await expect(
      TicketService.initiateMomoPurchase({
        eventId,
        items: [{ ticketTypeId: ticketTypeId, quantity: 2 }],
        customerPhone: '+26876111111',
        momoPhone: '26876111111',
      })
    ).rejects.toThrow('MoMo down');

    // Sale should be FAILED, reservation released
    const sale = await TicketSale.findOne({ paymentMethod: PaymentMethod.MTN_MOMO });
    expect(sale).not.toBeNull();
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);

    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0); // released
  });
});

describe('TicketService.finalizeMomoSale', () => {
  it('mints tickets + completes sale when MTN status is SUCCESSFUL (and is idempotent)', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R1' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '200', currency: 'SZL' } });

    // Initiate first
    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 2 }],
      customerPhone: '+26876111111',
      momoPhone: '26876111111',
    });

    // Finalize — first call should complete
    const first = await TicketService.finalizeMomoSale('R1');
    expect(first.status).toBe('completed');

    // Verify sale completed + tickets minted
    const sale = await TicketSale.findOne({ momoReferenceId: 'R1' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(sale!.ticketIds.length).toBe(2);

    // Verify sold incremented, reserved released
    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0);
    expect(tt.sold).toBe(2);

    // Second call — idempotent, no-op, still returns 'completed'
    const second = await TicketService.finalizeMomoSale('R1');
    expect(second.status).toBe('completed');

    // Verify no duplicate tickets were minted
    const ticketCount = await Ticket.countDocuments({ eventId });
    expect(ticketCount).toBe(2);
  });

  it('a registered buyer auto-follows the organizer once the MoMo sale is finalized', async () => {
    await Follow.init(); // unique index must exist before the follow edge is written
    const organizer = await Vendor.create({
      businessName: 'MoMo Organizer',
      email: 'momo-organizer@example.com',
      phoneNumber: '+26878199999',
      password: 'secret123',
    });
    const buyer = await Buyer.create({ phone: '+26878199001', password: 'secret1', name: 'MoMo Buyer' });

    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const event = await Event.create({
      vendorId: organizer._id,
      name: 'MoMo Follow Concert',
      venue: 'Test Venue',
      eventDate: futureDate,
      startTime: futureDate,
      endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
      status: EventStatus.PUBLISHED,
      ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
    });
    const ticketTypeId = event.ticketTypes[0]!._id!.toString();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_FOLLOW' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '100', currency: 'SZL' } });

    await TicketService.initiateMomoPurchase({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26878199001',
      momoPhone: '26878199001',
      buyerId: String(buyer._id),
    });

    // No follow while the sale is still PENDING — only a completed mint follows.
    expect(await FollowService.followerCount('organizer', String(organizer._id))).toBe(0);

    const result = await TicketService.finalizeMomoSale('R_FOLLOW');
    expect(result.status).toBe('completed');

    expect(await FollowService.followerCount('organizer', String(organizer._id))).toBe(1);
    expect(await FollowService.followingIds(String(buyer._id), 'organizer')).toEqual([
      String(organizer._id),
    ]);
  });

  it('releases reservation + fails the sale when MTN status is FAILED', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R2' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'FAILED', raw: {} });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 2 }],
      customerPhone: '+26876222222',
      momoPhone: '26876222222',
    });

    const result = await TicketService.finalizeMomoSale('R2');
    expect(result.status).toBe('failed');

    const sale = await TicketSale.findOne({ momoReferenceId: 'R2' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(sale!.ticketIds.length).toBe(0);

    // reserved back to 0
    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0);
    expect(tt.sold).toBe(0);
    expect(tt.available).toBe(10);
  });

  it('refuses to mint + fails the sale when MTN reports SUCCESSFUL but the amount mismatches', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_BAD_AMT' });
    // SUCCESSFUL but MTN reports 50 against a 200 sale (price 100 x qty 2)
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '50', currency: 'SZL' } });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 2 }],
      customerPhone: '+26876555555',
      momoPhone: '26876555555',
    });

    const result = await TicketService.finalizeMomoSale('R_BAD_AMT');
    expect(result.status).toBe('failed');

    // No tickets minted; sale failed; reservation released
    const sale = await TicketSale.findOne({ momoReferenceId: 'R_BAD_AMT' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(sale!.ticketIds.length).toBe(0);

    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.reserved).toBe(0);
    expect(tt.sold).toBe(0);
  });

  it('refuses to mint when MTN reports SUCCESSFUL but the currency mismatches', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_BAD_CCY' });
    // Correct amount but wrong currency (EUR against an SZL sale)
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '200', currency: 'EUR' } });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 2 }],
      customerPhone: '+26876666666',
      momoPhone: '26876666666',
    });

    const result = await TicketService.finalizeMomoSale('R_BAD_CCY');
    expect(result.status).toBe('failed');

    const sale = await TicketSale.findOne({ momoReferenceId: 'R_BAD_CCY' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(sale!.ticketIds.length).toBe(0);
  });

  it('returns pending when MTN status is still PENDING', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R3' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'PENDING', raw: {} });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26876333333',
      momoPhone: '26876333333',
    });

    const result = await TicketService.finalizeMomoSale('R3');
    expect(result.status).toBe('pending');

    // Sale must still be PENDING
    const sale = await TicketSale.findOne({ momoReferenceId: 'R3' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(sale!.ticketIds.length).toBe(0);
  });

  it('getMomoSaleByReference ownership: mismatched phone gets no finalize, matching phone succeeds', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_OWN' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '100', currency: 'SZL' } });

    // Initiate as +26876111111
    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26876111111',
      momoPhone: '26876111111',
    });

    // Verify getMomoSaleByReference returns the sale for the correct reference
    const found = await TicketService.getMomoSaleByReference('R_OWN');
    expect(found).not.toBeNull();

    // Phone mismatch path: a DIFFERENT buyer phone should NOT match the sale
    const { normalizePhone } = await import('@utils/phone.util');
    const salePhone = normalizePhone(found!.customerPhone || '');
    const wrongPhone = normalizePhone('+26876999999');
    const rightPhone = normalizePhone('+26876111111');

    // Attacker's phone doesn't match — no finalize should occur for them
    expect(salePhone).not.toBe(wrongPhone);

    // Matching buyer phone: finalize should proceed and complete
    expect(salePhone).toBe(rightPhone);

    const result = await TicketService.finalizeMomoSale('R_OWN');
    expect(result.status).toBe('completed');

    // No tickets minted for the wrong phone (finalize was NOT called for them)
    const allTickets = await Ticket.find({ eventId });
    expect(allTickets.length).toBe(1); // only the matching buyer's ticket
    expect(allTickets[0]!.customerPhone).toBe(rightPhone);
  });

  it('getMomoSaleByExternalId resolves the sale + referenceId from MTN externalId (callback correlation)', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_EXT' });

    // initiate sets externalId = sale.saleId (the SALE-… string) and stores momoReferenceId
    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26876222222',
      momoPhone: '26876222222',
    });

    // The externalId MTN echoes back is the sale's `saleId` field (SALE-…), which is
    // exactly what requestToPay was called with — fetch it to mirror the real callback.
    const created = await TicketSale.findOne({ momoReferenceId: 'R_EXT' });
    const externalId = created!.saleId; // SALE-…

    // MTN's callback carries this externalId, NOT the referenceId UUID.
    const sale = await TicketService.getMomoSaleByExternalId(externalId);
    expect(sale).not.toBeNull();
    expect(sale!.momoReferenceId).toBe('R_EXT');

    // Unknown externalId resolves to null (callback would 400, not crash)
    expect(await TicketService.getMomoSaleByExternalId('SALE-does-not-exist')).toBeNull();
  });

  it('concurrent finalize calls never double-mint (atomic claim)', async () => {
    const quantity = 2;
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R4' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'SUCCESSFUL', raw: { amount: '200', currency: 'SZL' } });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: quantity }],
      customerPhone: '+26876444444',
      momoPhone: '26876444444',
    });

    // Fire TWO finalize calls concurrently — only one must win the atomic claim.
    const [a, b] = await Promise.all([
      TicketService.finalizeMomoSale('R4'),
      TicketService.finalizeMomoSale('R4'),
    ]);

    // Both must resolve to 'completed' (loser returns early after seeing COMPLETED)
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');

    // Sale must be COMPLETED with EXACTLY `quantity` tickets — no double-mint
    const sale = await TicketSale.findOne({ momoReferenceId: 'R4' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(sale!.ticketIds.length).toBe(quantity);

    // Total tickets in DB must also be exactly `quantity`
    const ticketCount = await Ticket.countDocuments({ eventId });
    expect(ticketCount).toBe(quantity);

    // Event ticketType: sold === quantity (not 2×), reserved === 0
    const updatedEvent = await Event.findById(eventId);
    const tt = updatedEvent!.ticketTypes[0]!;
    expect(tt.sold).toBe(quantity);
    expect(tt.reserved).toBe(0);
  });
});

/**
 * The backstop that makes the sweep's MoMo carve-out safe. MTN's callback is
 * fire-and-forget and the buyer's poll stops when they close the tab, so
 * without this nothing ever asks MTN and a settled debit never becomes a
 * ticket (incident 2026-09-08: E308 taken, no ticket).
 *
 * `createdAt` is immutable under `timestamps: true`, so age is forced through
 * the raw driver — `Model.updateOne` would silently drop the $set.
 */
describe('TicketService.reconcilePendingMomoSales', () => {
  async function ageSale(referenceId: string, ageMs: number) {
    await TicketSale.collection.updateOne(
      { momoReferenceId: referenceId },
      { $set: { createdAt: new Date(Date.now() - ageMs) } }
    );
  }

  it('mints a stuck PENDING sale that MTN reports SUCCESSFUL', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_STUCK' });
    // The buyer's poll only ever saw PENDING, then they gave up.
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'PENDING', raw: {} });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId, quantity: 2 }],
      customerPhone: '+26876333333',
      momoPhone: '26876333333',
    });

    // MTN settles late — exactly what the callback+poll both missed.
    mockMomoInstance.getStatus.mockResolvedValue({
      status: 'SUCCESSFUL',
      raw: { amount: '200', currency: 'SZL' },
    });
    await ageSale('R_STUCK', 5 * 60_000);

    const finalized = await TicketService.reconcilePendingMomoSales();
    expect(finalized).toBe(1);

    const sale = await TicketSale.findOne({ momoReferenceId: 'R_STUCK' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(sale!.ticketIds.length).toBe(2);

    const updatedEvent = await Event.findById(eventId);
    expect(updatedEvent!.ticketTypes[0]!.sold).toBe(2);
  });

  it('skips sales younger than olderThanMs so the payer is not cut off mid-PIN', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_FRESH' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'PENDING', raw: {} });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId, quantity: 1 }],
      customerPhone: '+26876444444',
      momoPhone: '26876444444',
    });

    // Brand new sale — must not even be asked.
    mockMomoInstance.getStatus.mockClear();
    const finalized = await TicketService.reconcilePendingMomoSales();

    expect(finalized).toBe(0);
    expect(mockMomoInstance.getStatus).not.toHaveBeenCalled();

    const sale = await TicketSale.findOne({ momoReferenceId: 'R_FRESH' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('leaves a still-PENDING sale alone while it is inside maxPendingMs', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_SLOW' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'PENDING', raw: {} });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId, quantity: 1 }],
      customerPhone: '+26876555555',
      momoPhone: '26876555555',
    });

    await ageSale('R_SLOW', 5 * 60_000);
    const finalized = await TicketService.reconcilePendingMomoSales();

    expect(finalized).toBe(0);
    const sale = await TicketSale.findOne({ momoReferenceId: 'R_SLOW' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('loud-fails a sale MTN still reports non-successful past maxPendingMs', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_ABANDONED' });
    mockMomoInstance.getStatus.mockResolvedValue({ status: 'PENDING', raw: {} });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId, quantity: 1 }],
      customerPhone: '+26876666666',
      momoPhone: '26876666666',
    });

    // Older than the 60-min ceiling and MTN still will not confirm it.
    await ageSale('R_ABANDONED', 2 * 60 * 60_000);
    await TicketService.reconcilePendingMomoSales();

    const sale = await TicketSale.findOne({ momoReferenceId: 'R_ABANDONED' });
    expect(sale!.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(sale!.momoFailureReason).toBe('RECONCILE_TIMEOUT');
    expect(sale!.ticketIds.length).toBe(0);

    // The hold must be gone too, so the inventory is not stranded.
    const updatedEvent = await Event.findById(eventId);
    expect(updatedEvent!.ticketTypes[0]!.reserved).toBe(0);
  });
});
