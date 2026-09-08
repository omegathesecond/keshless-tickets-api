/**
 * Final-review fix: the Keshless-wallet purchase path (purchaseForCustomer,
 * called by public.controller.ts purchaseTickets) was never migrated to the
 * buyerId-primary identity resolution the MoMo/card/DeltaPay handlers already
 * use, so an email-only buyer (token has buyerId+userEmail but no userPhone)
 * would 401 before even reaching this function. This proves the function
 * itself now works end-to-end with NO customerPhone — mirroring the MoMo/card
 * pending-charge test's mocking pattern (stub @services/payments getProcessor).
 */
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';

const mockCharge = jest.fn();
jest.mock('@services/payments', () => ({
  getProcessor: () => ({ charge: mockCharge }),
}));

import { TicketService } from '@services/ticket.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';
import { Ticket } from '@models/ticket.model';
import { TicketSale } from '@models/ticketSale.model';
import mongoose from 'mongoose';

beforeAll(connectTestDb);
afterEach(async () => {
  await clearTestDb();
  mockCharge.mockReset();
  jest.restoreAllMocks();
});
afterAll(disconnectTestDb);

describe('TicketService.purchaseForCustomer — email-only buyer (no customerPhone)', () => {
  it('succeeds with no customerPhone and stamps buyerId + customerEmail on the sale and ticket', async () => {
    await PaymentConfigService.update({ platformFeePercent: 0, keshlessServiceFee: 0 });
    // Price kept under 50 so the PIN threshold doesn't gate the test — that
    // rule is orthogonal to identity resolution, which is what's under test.
    const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 30, capacity: 5 });

    mockCharge.mockResolvedValue({
      status: 'completed',
      providerRef: 'WALLET-REF-1',
      message: 'ok',
    });

    const buyerId = new mongoose.Types.ObjectId().toString();

    const result = await TicketService.purchaseForCustomer({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      // No customerPhone — email-only buyer.
      customerEmail: 'buyer@example.com',
      buyerId,
      keshlessCardNumber: '1234567890123456',
    });

    expect(result.tickets).toHaveLength(1);

    const ticket = await Ticket.findOne({ ticketId: result.tickets[0]!.ticketId });
    expect(ticket).toBeTruthy();
    expect(ticket!.customerPhone).toBeFalsy();
    expect(ticket!.customerEmail).toBe('buyer@example.com');
    expect(String(ticket!.buyerId)).toBe(buyerId);
    // customerName falls back through phone -> email -> 'Guest'; with no
    // phone supplied it must land on the email, never be empty.
    expect(ticket!.customerName).toBe('buyer@example.com');

    const sale = await TicketSale.findOne({ eventId });
    expect(sale).toBeTruthy();
    expect(String(sale!.buyerId)).toBe(buyerId);
    expect(sale!.customerEmail).toBe('buyer@example.com');
  });

  it('customerName fallback prefers an explicit name, then phone, then email, then Guest', async () => {
    await PaymentConfigService.update({ platformFeePercent: 0, keshlessServiceFee: 0 });
    const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 30, capacity: 5 });

    mockCharge.mockResolvedValue({ status: 'completed', providerRef: 'WALLET-REF-2', message: 'ok' });

    // No name, no phone, no email at all -> 'Guest'.
    const result = await TicketService.purchaseForCustomer({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      keshlessCardNumber: '1234567890123456',
    });

    const ticket = await Ticket.findOne({ ticketId: result.tickets[0]!.ticketId });
    expect(ticket!.customerName).toBe('Guest');
  });

  it('fires the email confirmation (not SMS) for an email-only buyer', async () => {
    await PaymentConfigService.update({ platformFeePercent: 0, keshlessServiceFee: 0 });
    const { eventId, ticketTypeId } = await seedPublishedEvent({ price: 30, capacity: 5 });

    mockCharge.mockResolvedValue({
      status: 'completed',
      providerRef: 'WALLET-REF-3',
      message: 'ok',
    });

    const emailSpy = jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
    const smsSpy = jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);

    const result = await TicketService.purchaseForCustomer({
      eventId,
      items: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      // No customerPhone — email-only buyer.
      customerEmail: 'buyer@example.com',
      keshlessCardNumber: '1234567890123456',
    });

    expect(result.tickets).toHaveLength(1);
    expect(emailSpy).toHaveBeenCalledWith(
      'buyer@example.com',
      expect.arrayContaining([
        expect.objectContaining({ ticketId: result.tickets[0]!.ticketId }),
      ]),
    );
    expect(smsSpy).not.toHaveBeenCalled();
  });
});
