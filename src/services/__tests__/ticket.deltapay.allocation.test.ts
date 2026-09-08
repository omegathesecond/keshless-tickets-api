/**
 * Integration: an online DeltaPay purchase of a reseller ALLOCATION tier
 * persists a sale attributed to the tier's reseller (kept off the organizer's
 * revenue) and charged at face (fee waived). Reuses the DeltapayClient mock
 * pattern from ticket.deltapay.test.ts.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

const createSession = jest.fn();
const verifySession = jest.fn();

jest.mock('@services/payments/deltapay.client', () => ({
  classifySessionStatus: jest.requireActual('@services/payments/deltapay.client').classifySessionStatus,
  DeltapayClient: jest.fn().mockImplementation(() => ({ isConfigured: () => true, createSession, verifySession })),
}));

import { TicketService } from '@services/ticket.service';
import { PaymentConfigService } from '@services/paymentConfig.service';

beforeAll(async () => {
  await connectTestDb();
  process.env['DELTAPAY_RETURN_URL'] = 'https://carrot.test/api/public/purchase/deltapay/return';
});
beforeEach(async () => {
  // Non-zero deltapay fee proves the waiver actually zeroes it (not just a 0 config).
  await PaymentConfigService.update({ deltapayEnabled: true, platformFeePercent: 0, deltapayServiceFee: 6 });
});
afterEach(async () => { await clearTestDb(); createSession.mockReset(); verifySession.mockReset(); });
afterAll(async () => { await disconnectTestDb(); });

async function seedAllocationEvent() {
  const vendorId = new mongoose.Types.ObjectId();
  const resellerId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const event = await Event.create({
    vendorId, name: 'Farmers Market', venue: 'V',
    eventDate: futureDate, startTime: futureDate, endTime: new Date(futureDate.getTime() + 7200000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      { name: 'General Ticket - DeltaPay Exclusive', price: 260, quantity: 100, sold: 0, reserved: 0,
        resellerId, isAllocation: true, allocationUnitCost: 250,
        restrictToMethod: PaymentMethod.DELTAPAY, waiveServiceFee: true },
    ],
  });
  return {
    eventId: event._id.toString(),
    allocId: event.ticketTypes[0]!._id!.toString(),
    resellerId: resellerId.toString(),
  };
}

describe('initiateDeltapayPurchase — reseller allocation tier', () => {
  it('attributes the sale to the tier reseller and charges face (fee waived)', async () => {
    const { eventId, allocId, resellerId } = await seedAllocationEvent();
    createSession.mockResolvedValue({ checkoutSessionId: 'sess_alloc', checkoutUrl: 'https://c' });

    await TicketService.initiateDeltapayPurchase({
      eventId, items: [{ ticketTypeId: allocId, quantity: 2 }], customerPhone: '+26878422613',
    } as any);

    const sale = await TicketSale.findOne({ deltapaySessionId: 'sess_alloc' });
    expect(sale).not.toBeNull();
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    // Attributed to the tier's reseller (→ DeltaPay's scoped reports + settlement)
    expect(String(sale!.resellerId)).toBe(resellerId);
    // Face only: 2 × 260, no service fee despite deltapayServiceFee = 6
    expect(sale!.totalAmount).toBe(520);
    expect(sale!.amountCharged).toBe(520);
  });
});
