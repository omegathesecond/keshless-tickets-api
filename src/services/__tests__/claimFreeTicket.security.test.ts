/**
 * Security regression: TicketService.claimFreeTicket is the no-payment
 * checkout path for a tier priced at 0. Because it mints tickets WITHOUT any
 * payment, the "this ticket is free" decision MUST be made server-side against
 * the stored tier price — never trusted from the caller. If a paid tier could
 * be claimed through here, buyers would get paid tickets for free: a revenue
 * (and integrity) incident. These tests pin that guard shut and prove a
 * genuinely-free claim mints at amount 0 through CASH/ONLINE (no gateway).
 */
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';

import { TicketService } from '@services/ticket.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';
import { TicketSale } from '@models/ticketSale.model';
import { PaymentMethod, PaymentStatus, SalesChannel } from '@interfaces/ticket.interface';
import mongoose from 'mongoose';

beforeAll(connectTestDb);
beforeEach(async () => {
  await PaymentConfigService.update({ platformFeePercent: 0 });
  // Confirmations are best-effort; stub them so the test never hits the network.
  jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
  jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
});
afterEach(async () => {
  await clearTestDb();
  jest.restoreAllMocks();
});
afterAll(disconnectTestDb);

describe('TicketService.claimFreeTicket — free-only enforcement', () => {
  it('REJECTS a paid tier — a paid ticket can never be claimed for free', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 100, capacity: 5 });

    await expect(
      TicketService.claimFreeTicket({
        eventId,
        items: [{ ticketTypeId, quantity: 1 }],
        customerEmail: 'attacker@example.com',
        buyerId: new mongoose.Types.ObjectId().toString(),
      }),
    ).rejects.toThrow('not free');

    // And nothing was minted as a side effect.
    expect(await TicketSale.countDocuments({ eventId })).toBe(0);
  });

  it('mints a genuinely-free tier at amount 0 through CASH/ONLINE (no gateway)', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 0, capacity: 5 });
    const buyerId = new mongoose.Types.ObjectId().toString();

    const result = await TicketService.claimFreeTicket({
      eventId,
      items: [{ ticketTypeId, quantity: 2 }],
      customerEmail: 'buyer@example.com',
      buyerId,
    });

    expect(result.totalAmount).toBe(0);
    expect(result.tickets).toHaveLength(2);

    const sale = await TicketSale.findOne({ eventId });
    expect(sale).toBeTruthy();
    expect(sale!.paymentMethod).toBe(PaymentMethod.CASH);
    expect(sale!.channel).toBe(SalesChannel.ONLINE);
    expect(sale!.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(sale!.totalAmount).toBe(0);
    expect(sale!.serviceFeeAmount).toBe(0);
    expect(sale!.amountCharged).toBe(0);
    expect(String(sale!.buyerId)).toBe(buyerId);
  });

  it('respects availability — cannot over-claim a limited free tier', async () => {
    const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 0, capacity: 1 });

    await expect(
      TicketService.claimFreeTicket({
        eventId,
        items: [{ ticketTypeId, quantity: 5 }],
        customerEmail: 'buyer@example.com',
        buyerId: new mongoose.Types.ObjectId().toString(),
      }),
    ).rejects.toThrow(/available/i);
  });
});
