/**
 * Task 9: ticket.snapshot.test.ts
 *
 * Every persisted TicketSale must carry the immutable economic snapshot so the
 * organizer-payout + reseller ledgers can see it. This covers the direct vendor
 * sale path (TicketService.sellTickets).
 */
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { TicketService } from '@services/ticket.service';
import { PaymentMethod } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('TicketService.sellTickets economic snapshot', () => {
  it('direct vendor cash sale writes snapshot with fundsCustody vendor', async () => {
    await PaymentConfigService.update({ platformFeePercent: 10 });
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({ price: 50, capacity: 5 });

    const { sale } = await TicketService.sellTickets({
      eventId,
      lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      vendorId,
      paymentMethod: PaymentMethod.CASH,
      soldBy: vendorId,
      soldByType: 'vendor',
      customerPhone: '+26878422613',
    });

    expect(sale.faceAmount).toBe(50);
    expect(sale.fundsCustody).toBe('vendor');
    expect(sale.platformFeePercent).toBe(10);
    expect(sale.platformFeeAmount).toBe(5);
    expect(sale.organizerProceeds).toBe(45);
    expect(sale.resellerCommissionAmount).toBe(0);
    expect(sale.resellerCommissionPercent).toBe(0);
  });
});
