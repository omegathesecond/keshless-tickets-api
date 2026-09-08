/**
 * Task 4 (Slice A): purchaseExternalGuard.test.ts
 * Regression test proving assertCarrotTicketing is wired into all three
 * purchase entry points on TicketService — an externally-sold event must
 * never be processed through purchaseForCustomer, initiateMomoPurchase, or
 * initiateCardPurchase.
 *
 * MtnMomoClient and PeachClient are mocked (same pattern as momoSale.test.ts
 * / ticket.card.test.ts) purely so `isConfigured()` reads true and execution
 * reaches the event-load + guard check; the guard itself is what's tested.
 */
jest.mock('@services/payments/mtnMomo.client', () => ({
  MtnMomoClient: jest.fn().mockImplementation(() => ({
    isConfigured: () => true,
    requestToPay: jest.fn(),
    getStatus: jest.fn(),
  })),
}));

jest.mock('@services/payments/peach.client', () => ({
  classifyResultCode: jest.requireActual('@services/payments/peach.client').classifyResultCode,
  PeachClient: jest.fn().mockImplementation(() => ({
    isConfigured: () => true,
    createPayment: jest.fn(),
    getPaymentStatus: jest.fn(),
  })),
}));

import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { TicketService } from '@services/ticket.service';

async function seedExternalEvent(name: string) {
  const e = await Event.create({
    vendorId: '507f1f77bcf86cd799439011',
    name,
    venue: 'V',
    eventDate: new Date(),
    startTime: new Date(),
    endTime: new Date(),
    status: EventStatus.PUBLISHED,
    ticketing: 'external',
    externalTicketUrl: 'https://x.tickets/e',
    ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }],
  });
  return { event: e, ticketTypeId: String(e.ticketTypes[0]!._id) };
}

describe('purchase refuses external events', () => {
  beforeAll(connectTestDb);
  beforeEach(async () => {
    // peachCardEnabled must be true for initiateCardPurchase to pass the
    // admin-toggle check and reach the event load + guard.
    await PaymentConfigService.update({ peachCardEnabled: true });
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('purchaseForCustomer throws for an external event', async () => {
    const { event, ticketTypeId } = await seedExternalEvent('Ext');

    await expect(
      TicketService.purchaseForCustomer({
        eventId: String(event._id),
        items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
        customerPhone: '+26878422613',
        keshlessCardNumber: '1234567890123456',
      }),
    ).rejects.toThrow('externally');
  });

  it('initiateMomoPurchase throws for an external event', async () => {
    const { event, ticketTypeId } = await seedExternalEvent('Ext Momo');

    await expect(
      TicketService.initiateMomoPurchase({
        eventId: String(event._id),
        items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
        customerPhone: '+26878422613',
        momoPhone: '+26878422613',
      }),
    ).rejects.toThrow('externally');
  });

  it('initiateCardPurchase throws for an external event', async () => {
    const { event, ticketTypeId } = await seedExternalEvent('Ext Card');

    await expect(
      TicketService.initiateCardPurchase({
        eventId: String(event._id),
        items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
        customerPhone: '+26878422613',
      }),
    ).rejects.toThrow('externally');
  });
});
