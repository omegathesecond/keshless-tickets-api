/**
 * The reseller till selling a basket.
 *
 * A reseller's "allocation balance" is not separate accounting — a block's
 * remaining is `tier.quantity - tier.sold` on the tier itself (see
 * AllocationService, which is a read-only view of exactly that). So the
 * per-line availability check resolveCart already does IS the allocation
 * check; there is no second ledger to reconcile.
 */
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers, seedReseller } from '../../__tests__/helpers/fixtures';
import { ResellerSaleService } from '@services/resellerSale.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { TicketSale } from '@models/ticketSale.model';

beforeAll(connectTestDb);
beforeEach(async () => {
  await PaymentConfigService.update({
    platformFeePercent: 0, cashEnabled: true, keshlessWalletEnabled: true, mtnMomoEnabled: true,
  });
  jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
  jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
});
afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
afterAll(disconnectTestDb);

describe('ResellerSaleService — multi-tier till sale', () => {
  it('rings up two tiers in one cash sale', async () => {
    const { resellerId, hubId } = await seedReseller();
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'General', price: 100, quantity: 10 },
      { name: 'VIP', price: 250, quantity: 5 },
    ]);

    const result = await ResellerSaleService.createSale({
      operatorId: new mongoose.Types.ObjectId().toString(),
      resellerId, hubId, eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      paymentMethod: 'cash',
      customerName: 'Walk-up Buyer',
    });

    expect(result.status).toBe('completed');

    const sale = await TicketSale.findOne({ eventId });
    expect(sale!.quantity).toBe(3);
    expect(sale!.totalAmount).toBe(450);
    // Rung at face — a till sale carries no buyer service fee.
    expect(sale!.serviceFeeAmount ?? 0).toBe(0);

    const minted = await Ticket.find({ saleId: sale!._id }).sort({ price: 1 });
    expect(minted.map((t) => t.ticketType)).toEqual(['General', 'General', 'VIP']);
  });

  it('moves each tier’s own sold counter', async () => {
    const { resellerId, hubId } = await seedReseller();
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'General', price: 100, quantity: 10 },
      { name: 'VIP', price: 250, quantity: 5 },
    ]);

    await ResellerSaleService.createSale({
      operatorId: new mongoose.Types.ObjectId().toString(),
      resellerId, hubId, eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      paymentMethod: 'cash',
    });

    const after = await Event.findById(eventId);
    expect(after!.ticketTypes[0]!.sold).toBe(2);
    expect(after!.ticketTypes[1]!.sold).toBe(1);
  });

  it('refuses to oversell an allocation block (its remaining IS tier availability)', async () => {
    const { resellerId, hubId } = await seedReseller();
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      // A pre-bought block of 3, one already sold — 2 remain.
      { name: 'Reseller Block', price: 100, quantity: 3, sold: 1,
        isAllocation: true, resellerId: new mongoose.Types.ObjectId(resellerId) },
    ]);

    await expect(ResellerSaleService.createSale({
      operatorId: new mongoose.Types.ObjectId().toString(),
      resellerId, hubId, eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 3 }],
      paymentMethod: 'cash',
    })).rejects.toThrow(/only 2/i);
  });

  it('rejects a cart mixing an allocation block with an ordinary tier', async () => {
    const { resellerId, hubId } = await seedReseller();
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'General', price: 100, quantity: 10 },
      { name: 'Reseller Block', price: 100, quantity: 10,
        isAllocation: true, resellerId: new mongoose.Types.ObjectId(resellerId) },
    ]);

    // A sale carries ONE resellerId; a cart spanning both has no correct value.
    await expect(ResellerSaleService.createSale({
      operatorId: new mongoose.Types.ObjectId().toString(),
      resellerId, hubId, eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 1 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      paymentMethod: 'cash',
    })).rejects.toThrow(/allocation/i);
  });

  it('still sells a single tier exactly as before (equivalence)', async () => {
    const { resellerId, hubId } = await seedReseller();
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'General', price: 100, quantity: 10 },
    ]);

    const result = await ResellerSaleService.createSale({
      operatorId: new mongoose.Types.ObjectId().toString(),
      resellerId, hubId, eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }],
      paymentMethod: 'cash',
    });

    expect(result.status).toBe('completed');
    const sale = await TicketSale.findOne({ eventId });
    expect(sale!.quantity).toBe(2);
    expect(sale!.totalAmount).toBe(200);
    expect(sale!.lines).toHaveLength(1);
  });
});
