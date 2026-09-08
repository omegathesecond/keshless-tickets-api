/**
 * Fix C2: sellTickets must NOT mark a `pending` charge as COMPLETED.
 *
 * A processor that returns `status: 'pending'` (async/uncollected money) must
 * persist the sale as paymentStatus PENDING — never COMPLETED — so the
 * organizer-payout ledger (which counts only `completed`) does not credit the
 * organizer for money that has not yet been collected.
 *
 * We mock the payments module so getProcessor returns a stub processor whose
 * charge() resolves to `pending`.
 */
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

// Mock the payments module BEFORE importing TicketService so getProcessor is stubbed.
const mockCharge = jest.fn();
jest.mock('@services/payments', () => ({
  getProcessor: () => ({ charge: mockCharge }),
}));

import { TicketService } from '@services/ticket.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { SettlementService } from '@services/settlement.service';

beforeAll(connectTestDb);
afterEach(async () => {
  await clearTestDb();
  mockCharge.mockReset();
});
afterAll(disconnectTestDb);

describe('TicketService.sellTickets — pending charge status', () => {
  it('persists paymentStatus PENDING (not COMPLETED) when the processor returns pending', async () => {
    await PaymentConfigService.update({ platformFeePercent: 0 });
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({ price: 100, capacity: 5 });

    mockCharge.mockResolvedValue({
      status: 'pending',
      providerRef: 'PENDING-REF-1',
      message: 'Awaiting confirmation',
    });

    const { sale } = await TicketService.sellTickets({
      eventId,
      lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      vendorId,
      paymentMethod: PaymentMethod.KESHLESS_WALLET,
      soldBy: vendorId,
      soldByType: 'vendor',
      customerPhone: '+26878422613',
    });

    expect(sale.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('a pending sale is NOT counted in availableProceeds by previewOrganizerPayout', async () => {
    await PaymentConfigService.update({ platformFeePercent: 0 });
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({ price: 100, capacity: 5 });

    mockCharge.mockResolvedValue({
      status: 'pending',
      providerRef: 'PENDING-REF-2',
      message: 'Awaiting confirmation',
    });

    await TicketService.sellTickets({
      eventId,
      lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      vendorId,
      paymentMethod: PaymentMethod.KESHLESS_WALLET,
      soldBy: vendorId,
      soldByType: 'vendor',
      customerPhone: '+26878422613',
    });

    const from = new Date(Date.now() - 60 * 60 * 1000);
    const to = new Date(Date.now() + 60 * 60 * 1000);
    const preview = await SettlementService.previewOrganizerPayout(vendorId, from, to);

    // Pending sale is excluded from the ledger entirely.
    expect(preview.availableProceeds).toBe(0);
    expect(preview.proceedsOwed).toBe(0);
  });

  it('still persists COMPLETED when the processor returns completed (regression)', async () => {
    await PaymentConfigService.update({ platformFeePercent: 0 });
    const { eventId, ticketTypeId, vendorId } = await seedPublishedEvent({ price: 100, capacity: 5 });

    mockCharge.mockResolvedValue({ status: 'completed', message: 'ok' });

    const { sale } = await TicketService.sellTickets({
      eventId,
      lines: [{ ticketTypeId: ticketTypeId, quantity: 1 }],
      vendorId,
      paymentMethod: PaymentMethod.KESHLESS_WALLET,
      soldBy: vendorId,
      soldByType: 'vendor',
      customerPhone: '+26878422613',
    });

    expect(sale.paymentStatus).toBe(PaymentStatus.COMPLETED);
  });
});
