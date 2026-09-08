/**
 * Fix C1-prep: initiateMomoPurchase must be parameterizable for reseller
 * attribution. A reseller MoMo initiate produces a PENDING sale with the SAME
 * snapshot shape as a reseller cash sale EXCEPT fundsCustody is 'carrot'
 * (electronic): soldByType 'ResellerOperator', resellerId/hubId set, and
 * organizerProceeds = face − commission (0 platform fee).
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentStatus } from '@interfaces/ticket.interface';

// Mock MtnMomoClient BEFORE importing TicketService (same pattern as momoSale.test.ts).
const mockMomoInstance = {
  isConfigured: jest.fn(),
  requestToPay: jest.fn(),
  getStatus: jest.fn(),
};
jest.mock('@services/payments/mtnMomo.client', () => ({
  MtnMomoClient: jest.fn().mockImplementation(() => mockMomoInstance),
}));

import { TicketService } from '@services/ticket.service';
import { PaymentConfigService } from '@services/paymentConfig.service';

beforeAll(connectTestDb);
afterEach(async () => {
  await clearTestDb();
  mockMomoInstance.isConfigured.mockReset();
  mockMomoInstance.requestToPay.mockReset();
  mockMomoInstance.getStatus.mockReset();
});
afterAll(disconnectTestDb);

async function seedPublishedEvent() {
  const vendorId = new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const event = await Event.create({
    vendorId,
    name: 'Reseller MoMo Concert',
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

describe('TicketService.initiateMomoPurchase — reseller attribution', () => {
  it('builds a PENDING reseller sale: ResellerOperator, carrot custody, proceeds = face − commission', async () => {
    await PaymentConfigService.update({ platformFeePercent: 0 });
    const { eventId, ticketTypeId } = await seedPublishedEvent();

    const resellerId = new mongoose.Types.ObjectId().toString();
    const hubId = new mongoose.Types.ObjectId().toString();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_RES' });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26876111111',
      momoPhone: '26876111111',
      soldByType: 'reseller-operator',
      soldBy: resellerId,
      resellerId,
      hubId,
      resellerCommissionPercent: 8,
    });

    const sale = await TicketSale.findOne({ momoReferenceId: 'R_RES' });
    expect(sale).not.toBeNull();
    expect(sale!.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(sale!.soldByType).toBe('ResellerOperator');
    expect(sale!.resellerId!.toString()).toBe(resellerId);
    expect(sale!.hubId!.toString()).toBe(hubId);
    expect(sale!.fundsCustody).toBe('carrot'); // electronic
    expect(sale!.faceAmount).toBe(100);
    expect(sale!.resellerCommissionPercent).toBe(8);
    expect(sale!.resellerCommissionAmount).toBe(8);
    expect(sale!.platformFeeAmount).toBe(0);
    expect(sale!.organizerProceeds).toBe(92); // face − commission − fee
  });

  it('still defaults to vendor attribution when reseller fields are absent (regression)', async () => {
    await PaymentConfigService.update({ platformFeePercent: 0 });
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent();

    mockMomoInstance.isConfigured.mockReturnValue(true);
    mockMomoInstance.requestToPay.mockResolvedValue({ referenceId: 'R_VEN' });

    await TicketService.initiateMomoPurchase({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      customerPhone: '+26876222222',
      momoPhone: '26876222222',
    });

    const sale = await TicketSale.findOne({ momoReferenceId: 'R_VEN' });
    expect(sale!.soldByType).toBe('Vendor');
    expect(sale!.soldBy!.toString()).toBe(vendorId.toString());
    expect(sale!.resellerId).toBeUndefined();
    expect(sale!.fundsCustody).toBe('carrot');
    expect(sale!.resellerCommissionAmount).toBe(0);
    expect(sale!.organizerProceeds).toBe(100);
  });
});
