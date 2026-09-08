/**
 * Events flagged `organizerAbsorbsServiceFee`: the buyer is charged exactly
 * face, and the same per-method booking fee is billed to the ORGANIZER by
 * deducting it from organizerProceeds. Exercised over the DeltaPay rail —
 * the fee wiring is identical on every online rail, so one is representative.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { SalesChannel } from '@interfaces/ticket.interface';

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
  await PaymentConfigService.update({ deltapayEnabled: true, platformFeePercent: 0, deltapayServiceFee: 5 });
  createSession.mockResolvedValue({ checkoutSessionId: 'sess_absorb', checkoutUrl: 'https://c' });
});

afterEach(async () => {
  await clearTestDb();
  createSession.mockReset();
});

afterAll(async () => {
  await disconnectTestDb();
});

async function seedEvent(organizerAbsorbsServiceFee: boolean) {
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Absorb Test Concert',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    organizerAbsorbsServiceFee,
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  return { eventId: event._id.toString(), ticketTypeId: event.ticketTypes[0]!._id!.toString() };
}

async function buyTwo(absorbs: boolean, channel: SalesChannel = SalesChannel.ONLINE) {
  const { eventId, ticketTypeId } = await seedEvent(absorbs);
  await TicketService.initiateDeltapayPurchase({
    eventId, items: [{ ticketTypeId, quantity: 2 }], customerPhone: '+26878422613', channel,
  } as any);
  return (await TicketSale.findOne({ deltapaySessionId: 'sess_absorb' }))!;
}

describe('event with organizerAbsorbsServiceFee', () => {
  it('charges the gateway exactly face — the buyer sees no fee', async () => {
    await buyTwo(true);
    expect(createSession.mock.calls[0]![0].amount).toBe(200);
  });

  it('records the fee against the organizer, not the buyer', async () => {
    const sale = await buyTwo(true);
    expect(sale.serviceFeeAmount).toBe(0);
    expect(sale.amountCharged).toBe(200);
    expect(sale.absorbedServiceFeeAmount).toBe(10); // E5 × 2 tickets
  });

  it('deducts the absorbed fee from what the organizer takes home', async () => {
    const sale = await buyTwo(true);
    expect(sale.organizerProceeds).toBe(190);
  });
});

describe('event without the flag — unchanged buyer-paid fee', () => {
  it('still charges the buyer face + fee and leaves proceeds at face', async () => {
    const sale = await buyTwo(false);
    expect(createSession.mock.calls[0]![0].amount).toBe(210);
    expect(sale.serviceFeeAmount).toBe(10);
    expect(sale.absorbedServiceFeeAmount).toBe(0);
    expect(sale.organizerProceeds).toBe(200);
  });
});

describe('absorbing event, sold at the box office', () => {
  it('bills the organizer nothing — off-line sales never carried a fee to move', async () => {
    const sale = await buyTwo(true, SalesChannel.BOX_OFFICE);
    expect(sale.serviceFeeAmount).toBe(0);
    expect(sale.absorbedServiceFeeAmount).toBe(0);
    expect(sale.organizerProceeds).toBe(200);
  });
});
