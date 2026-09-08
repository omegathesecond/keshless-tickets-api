/**
 * sellTickets is the single mint choke point every sale path funnels through
 * (buyer checkout, POS, reseller, free claim). These tests pin its multi-line
 * behaviour: the right tier and price on every ticket, one sale carrying them
 * all, and each tier's own inventory counter moved by its own quantity.
 *
 * The equivalence test is the acceptance bar for the whole slice — a one-line
 * cart must still produce exactly what the single-tier path produced.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers } from '../../__tests__/helpers/fixtures';
import { TicketService } from '@services/ticket.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { PaymentMethod, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(connectTestDb);
beforeEach(async () => {
  await PaymentConfigService.update({ platformFeePercent: 0 });
  jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
  jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
});
afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
afterAll(disconnectTestDb);

const TIERS = [
  { name: 'General', price: 100, quantity: 10 },
  { name: 'VIP', price: 250, quantity: 5 },
];

describe('sellTickets — multi-line', () => {
  it('mints the right tier and price for each line, under one sale', async () => {
    const { eventId, vendorId, event } = await seedEventWithTiers(TIERS);
    const [gen, vip] = event.ticketTypes;

    const { sale, tickets } = await TicketService.sellTickets({
      eventId,
      vendorId,
      lines: [
        { ticketTypeId: gen!._id!.toString(), quantity: 2 },
        { ticketTypeId: vip!._id!.toString(), quantity: 1 },
      ],
      customerName: 'Test Buyer',
      paymentMethod: PaymentMethod.CASH,
      soldBy: vendorId,
      soldByType: 'vendor',
      channel: SalesChannel.ONLINE,
    });

    expect(tickets).toHaveLength(3);
    expect(sale.quantity).toBe(3);
    expect(sale.totalAmount).toBe(450);
    expect(sale.ticketIds).toHaveLength(3);

    const minted = await Ticket.find({ saleId: sale._id }).sort({ price: 1 });
    expect(minted.map((t) => t.ticketType)).toEqual(['General', 'General', 'VIP']);
    expect(minted.map((t) => t.price)).toEqual([100, 100, 250]);
  });

  it('moves EACH tier’s own sold counter by its own quantity', async () => {
    const { eventId, vendorId, event } = await seedEventWithTiers(TIERS);
    const [gen, vip] = event.ticketTypes;

    await TicketService.sellTickets({
      eventId,
      vendorId,
      lines: [
        { ticketTypeId: gen!._id!.toString(), quantity: 2 },
        { ticketTypeId: vip!._id!.toString(), quantity: 1 },
      ],
      customerName: 'Test Buyer',
      paymentMethod: PaymentMethod.CASH,
      soldBy: vendorId,
      soldByType: 'vendor',
      channel: SalesChannel.ONLINE,
    });

    const after = await Event.findById(eventId);
    expect(after!.ticketTypes[0]!.sold).toBe(2);
    expect(after!.ticketTypes[0]!.available).toBe(8);
    expect(after!.ticketTypes[1]!.sold).toBe(1);
    expect(after!.ticketTypes[1]!.available).toBe(4);
    expect(after!.totalTicketsSold).toBe(3);
    expect(after!.totalRevenue).toBe(450);
  });

  it('is equivalent to the old single-tier path for a one-line cart', async () => {
    const { eventId, vendorId, event } = await seedEventWithTiers(TIERS);
    const gen = event.ticketTypes[0]!;

    const { sale, tickets } = await TicketService.sellTickets({
      eventId,
      vendorId,
      lines: [{ ticketTypeId: gen._id!.toString(), quantity: 2 }],
      customerName: 'Test Buyer',
      paymentMethod: PaymentMethod.CASH,
      soldBy: vendorId,
      soldByType: 'vendor',
      channel: SalesChannel.ONLINE,
    });

    expect(tickets).toHaveLength(2);
    expect(sale.quantity).toBe(2);
    expect(sale.totalAmount).toBe(200);
    expect(tickets.every((t) => t.ticketType === 'General')).toBe(true);

    const after = await Event.findById(eventId);
    expect(after!.ticketTypes[0]!.sold).toBe(2);
    expect(after!.ticketTypes[1]!.sold).toBe(0);
  });

  it('does not credit organizer revenue for an allocation line', async () => {
    const resellerId = new mongoose.Types.ObjectId();
    const { eventId, vendorId, event } = await seedEventWithTiers([
      { name: 'Reseller Block', price: 100, quantity: 10, isAllocation: true, resellerId },
    ]);
    const block = event.ticketTypes[0]!;

    await TicketService.sellTickets({
      eventId,
      vendorId,
      lines: [{ ticketTypeId: block._id!.toString(), quantity: 2 }],
      customerName: 'Test Buyer',
      paymentMethod: PaymentMethod.CASH,
      soldBy: vendorId,
      soldByType: 'vendor',
      channel: SalesChannel.ONLINE,
    });

    const after = await Event.findById(eventId);
    expect(after!.totalTicketsSold).toBe(2); // seats still count
    expect(after!.totalRevenue).toBe(0);     // but the money is the reseller's
  });
});
