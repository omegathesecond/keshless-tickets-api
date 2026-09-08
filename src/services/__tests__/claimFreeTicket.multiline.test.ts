/**
 * The free-claim rail over a cart. It mints WITHOUT any payment, so the
 * "everything here is free" decision must be made server-side against every
 * stored tier price — a single paid line must not be able to ride along in a
 * cart of free ones.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers } from '../../__tests__/helpers/fixtures';
import { TicketService } from '@services/ticket.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';
import { Ticket } from '@models/ticket.model';
import { TicketSale } from '@models/ticketSale.model';

beforeAll(connectTestDb);
beforeEach(async () => {
  await PaymentConfigService.update({ platformFeePercent: 0 });
  jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
  jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
});
afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
afterAll(disconnectTestDb);

describe('claimFreeTicket — multi-tier', () => {
  it('claims two free tiers in one request, minting both', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'Free GA', price: 0, quantity: 10 },
      { name: 'Free Kids', price: 0, quantity: 10 },
    ]);

    const result = await TicketService.claimFreeTicket({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      customerEmail: 'buyer@example.com',
      buyerId: new mongoose.Types.ObjectId().toString(),
    });

    expect(result.quantity).toBe(3);
    expect(result.totalAmount).toBe(0);

    const sale = await TicketSale.findOne({ eventId });
    const minted = await Ticket.find({ saleId: sale!._id });
    expect(minted).toHaveLength(3);
    expect(minted.filter((t) => t.ticketType === 'Free GA')).toHaveLength(2);
    expect(minted.filter((t) => t.ticketType === 'Free Kids')).toHaveLength(1);
  });

  it('REJECTS a cart where any line is paid, and mints nothing', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'Free GA', price: 0, quantity: 10 },
      { name: 'Paid VIP', price: 250, quantity: 10 },
    ]);

    await expect(TicketService.claimFreeTicket({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 1 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      customerEmail: 'attacker@example.com',
      buyerId: new mongoose.Types.ObjectId().toString(),
    })).rejects.toThrow(/not free/i);

    expect(await TicketSale.countDocuments({ eventId })).toBe(0);
    expect(await Ticket.countDocuments({ eventId })).toBe(0);
  });

  it('still mints a single free tier exactly as before (equivalence)', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'Free GA', price: 0, quantity: 10 },
    ]);

    const result = await TicketService.claimFreeTicket({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }],
      customerEmail: 'buyer@example.com',
      buyerId: new mongoose.Types.ObjectId().toString(),
    });

    expect(result.quantity).toBe(2);
    expect(result.totalAmount).toBe(0);

    const sale = await TicketSale.findOne({ eventId });
    expect(sale!.totalAmount).toBe(0);
    expect(sale!.serviceFeeAmount).toBe(0);
    expect(sale!.quantity).toBe(2);
  });

  it('enforces the per-account cap across the whole free cart', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers(
      [
        { name: 'Free GA', price: 0, quantity: 10 },
        { name: 'Free Kids', price: 0, quantity: 10 },
      ],
      { maxTicketsPerAccount: 2 }
    );

    await expect(TicketService.claimFreeTicket({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      customerEmail: 'buyer@example.com',
      buyerId: new mongoose.Types.ObjectId().toString(),
    })).rejects.toThrow(/limited to 2/i);
  });
});
