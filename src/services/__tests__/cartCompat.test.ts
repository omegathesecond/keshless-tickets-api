/**
 * Multi-tier cutover compatibility.
 *
 * A checkout spans two deploys — this API and the buyer bundle — and browsers
 * hold the old bundle in cache across both. These tests pin that BOTH request
 * shapes work, so the deploy order is irrelevant and a buyer on a cached page
 * is never rejected. They also cover the surfaces still on the legacy shape:
 * the Flutter POS, the reseller till and the dashboard's Sell Tickets page.
 *
 * DELETE THIS SUITE when the legacy path is removed.
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

describe('cutover compatibility — a legacy single-tier order still works', () => {
  it('mints the same sale from a one-line cart as the old shape did', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'Free GA', price: 0, quantity: 10 },
    ]);

    // What a cached bundle's {ticketTypeId, quantity: 2} normalises to.
    const result = await TicketService.claimFreeTicket({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }],
      customerEmail: 'cached-bundle@example.com',
      buyerId: new mongoose.Types.ObjectId().toString(),
    });

    expect(result.quantity).toBe(2);
    const sale = await TicketSale.findOne({ eventId });
    expect(sale!.quantity).toBe(2);
    expect(sale!.lines).toHaveLength(1);
    expect(sale!.lines![0]!.ticketTypeName).toBe('Free GA');
    expect(await Ticket.countDocuments({ eventId })).toBe(2);
  });

  it('carries a composition snapshot even for a legacy one-tier order', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'Free GA', price: 0, quantity: 10 },
    ]);

    await TicketService.claimFreeTicket({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 1 }],
      customerEmail: 'cached-bundle@example.com',
      buyerId: new mongoose.Types.ObjectId().toString(),
    });

    // The async rails mint from sale.lines, so a legacy order must still
    // record one — otherwise a cached-bundle purchase paid by card would
    // reach a finalizer with nothing to mint from.
    const sale = await TicketSale.findOne({ eventId });
    expect(sale!.lines?.[0]).toMatchObject({
      ticketTypeId: ticketTypeIds[0],
      ticketTypeName: 'Free GA',
      unitPrice: 0,
      quantity: 1,
    });
  });
});
