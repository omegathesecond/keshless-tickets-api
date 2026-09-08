import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { TicketService, deriveChannel } from '@services/ticket.service';
import { PaymentMethod, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('deriveChannel', () => {
  it('maps ResellerOperator to reseller_pos', () => {
    expect(deriveChannel('ResellerOperator')).toBe(SalesChannel.RESELLER_POS);
  });
  it('maps Vendor / VendorSubUser to box_office', () => {
    expect(deriveChannel('Vendor')).toBe(SalesChannel.BOX_OFFICE);
    expect(deriveChannel('VendorSubUser')).toBe(SalesChannel.BOX_OFFICE);
  });
});

describe('sellTickets channel', () => {
  it('vendor cash sale defaults to box_office', async () => {
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({ price: 50, capacity: 5 });
    const { sale } = await TicketService.sellTickets({
      eventId, lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }], vendorId,
      paymentMethod: PaymentMethod.CASH, soldBy: vendorId, soldByType: 'vendor',
      customerPhone: '+26878422613',
    });
    expect(sale.channel).toBe('box_office');
  });

  it('explicit channel overrides the derived default', async () => {
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({ price: 50, capacity: 5 });
    const { sale } = await TicketService.sellTickets({
      eventId, lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }], vendorId,
      paymentMethod: PaymentMethod.CASH, soldBy: vendorId, soldByType: 'vendor',
      customerPhone: '+26878422613', channel: SalesChannel.ONLINE,
    });
    expect(sale.channel).toBe('online');
  });
});
