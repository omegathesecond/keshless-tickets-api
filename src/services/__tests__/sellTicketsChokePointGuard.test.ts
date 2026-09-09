/**
 * Task 4b (Slice A follow-up): regression coverage for the CRITICAL gap Task 4
 * left open. Task 4 wired assertCarrotTicketing into the 3 ONLINE purchase
 * entry points (purchaseForCustomer / initiateMomoPurchase / initiateCardPurchase)
 * but left the actual ticket-minting choke point — TicketService.sellTickets —
 * unguarded. That choke point is reachable directly from:
 *   - the vendor/sub-user POS "sell tickets" controller (cash), and
 *   - the reseller-operator CASH + keshless_wallet lane (resellerSale.service),
 * both of which never went through the guarded online methods.
 *
 * The fix adds assertCarrotTicketing to sellTickets itself (single choke
 * point), so every caller — including future ones — is covered. These tests
 * exercise the two previously-unguarded paths directly, proving an `external`
 * event is refused.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/db';
import { seedPublishedEvent, seedReseller } from '../../__tests__/helpers/fixtures';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { PaymentMethod } from '@interfaces/ticket.interface';
import { ResellerSaleService } from '@services/resellerSale.service';
import { TicketService } from '@services/ticket.service';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

describe('reseller cash/wallet sales refuse external events (resellerSale.service)', () => {
  it('CASH sale for an external event rejects before minting', async () => {
    await PaymentConfigService.update({ cashEnabled: true });
    const { resellerId, hubId } = await seedReseller();
    const { eventId, ticketTypeId } = await seedPublishedEvent({
      price: 100,
      capacity: 5,
      ticketing: 'external',
    });

    await expect(
      ResellerSaleService.createSale({
        operatorId: new mongoose.Types.ObjectId().toString(),
        resellerId,
        hubId,
        eventId,
        items: [{ ticketTypeId, quantity: 1 }],
        paymentMethod: 'cash',
        customerPhone: '+26878422613',
      })
    ).rejects.toThrow('externally');

    const { Ticket } = await import('@models/ticket.model');
    expect(await Ticket.countDocuments({ eventId })).toBe(0);
  });

  it('keshless_wallet sale for an external event rejects before minting', async () => {
    await PaymentConfigService.update({ keshlessWalletEnabled: true });
    const { resellerId, hubId } = await seedReseller();
    const { eventId, ticketTypeId } = await seedPublishedEvent({
      price: 100,
      capacity: 5,
      ticketing: 'external',
    });

    await expect(
      ResellerSaleService.createSale({
        operatorId: new mongoose.Types.ObjectId().toString(),
        resellerId,
        hubId,
        eventId,
        items: [{ ticketTypeId, quantity: 1 }],
        paymentMethod: 'keshless_wallet',
        customerPhone: '+26878422613',
        keshlessCardNumber: '1234567890123456',
        keshlessPin: '1234',
      })
    ).rejects.toThrow('externally');

    const { Ticket } = await import('@models/ticket.model');
    expect(await Ticket.countDocuments({ eventId })).toBe(0);
  });
});

describe('POS "sell tickets" path refuses external events (TicketService.sellTickets)', () => {
  it('cash sale via sellTickets (the exact call the POS controller makes) rejects for an external event', async () => {
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({
      price: 50,
      capacity: 10,
      ticketing: 'external',
    });

    await expect(
      TicketService.sellTickets({
        eventId,
        vendorId,
        lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
        customerName: 'Walk-up buyer',
        customerPhone: '+26878422613',
        paymentMethod: PaymentMethod.CASH,
        soldBy: vendorId,
        soldByType: 'vendor',
      })
    ).rejects.toThrow('externally');

    const { Ticket } = await import('@models/ticket.model');
    expect(await Ticket.countDocuments({ eventId })).toBe(0);
  });

  it('sub-user sale via sellTickets rejects for an external event', async () => {
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({
      price: 50,
      capacity: 10,
      ticketing: 'external',
    });

    await expect(
      TicketService.sellTickets({
        eventId,
        vendorId,
        lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
        paymentMethod: PaymentMethod.CASH,
        soldBy: new mongoose.Types.ObjectId().toString(),
        soldByType: 'sub-user',
      })
    ).rejects.toThrow('externally');
  });

  it('a `carrot` (default) event is unaffected — sale still succeeds', async () => {
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({
      price: 50,
      capacity: 10,
    });

    const result = await TicketService.sellTickets({
      eventId,
      vendorId,
      lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      paymentMethod: PaymentMethod.CASH,
      soldBy: vendorId,
      soldByType: 'vendor',
    });

    expect(result.tickets).toHaveLength(1);
  });
});
