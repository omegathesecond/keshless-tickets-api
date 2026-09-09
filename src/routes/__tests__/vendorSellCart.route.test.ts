/**
 * POST /api/tickets/sales/sell — the box-office / dashboard sell path.
 *
 * Pins that it takes a basket AND still takes the legacy single-tier pair,
 * because the dashboard ships separately from this API and a mid-changeover
 * build must keep selling.
 */
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers } from '../../__tests__/helpers/fixtures';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { TicketSale } from '@models/ticketSale.model';
import { Ticket } from '@models/ticket.model';
import { Vendor } from '@models/vendor.model';
import { signVendorToken } from '../../__tests__/helpers/auth';
import mongoose from 'mongoose';

let token = '';
let vendorId = '';

beforeAll(connectTestDb);
beforeEach(async () => {
  await PaymentConfigService.update({ platformFeePercent: 0, cashEnabled: true });
  jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
  jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);

  const vendor = await Vendor.create({
    businessName: 'Box Office Co', email: 'box@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  vendorId = vendor._id.toString();
  token = signVendorToken(vendorId, { permissions: ['tickets:sell_tickets'] });
});
afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
afterAll(disconnectTestDb);

const sell = (body: Record<string, unknown>) =>
  request(app).post('/api/tickets/sales/sell').set('Authorization', `Bearer ${token}`).send(body);

describe('POST /api/tickets/sales/sell — cart', () => {
  it('sells two tiers in one transaction', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'General', price: 100, quantity: 10 },
      { name: 'VIP', price: 250, quantity: 5 },
    ], { vendorId: new mongoose.Types.ObjectId(vendorId) });

    const res = await sell({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0], quantity: 2 },
        { ticketTypeId: ticketTypeIds[1], quantity: 1 },
      ],
      paymentMethod: 'cash',
      customerName: 'Walk-up',
      customerPhone: '+26878422613',
    });

    expect(res.status).toBe(201);
    const sale = await TicketSale.findOne({ eventId });
    expect(sale!.quantity).toBe(3);
    expect(sale!.totalAmount).toBe(450);
    const minted = await Ticket.find({ saleId: sale!._id }).sort({ price: 1 });
    expect(minted.map((t) => t.ticketType)).toEqual(['General', 'General', 'VIP']);
  });

  it('still accepts a legacy single-tier body (dashboard mid-changeover)', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'General', price: 100, quantity: 10 },
    ], { vendorId: new mongoose.Types.ObjectId(vendorId) });

    const res = await sell({
      eventId,
      ticketTypeId: ticketTypeIds[0],
      quantity: 2,
      paymentMethod: 'cash',
      customerName: 'Walk-up',
      customerPhone: '+26878422613',
    });

    expect(res.status).toBe(201);
    const sale = await TicketSale.findOne({ eventId });
    expect(sale!.quantity).toBe(2);
    expect(sale!.lines).toHaveLength(1);
  });

  it('rejects a body naming no tier at all', async () => {
    const { eventId } = await seedEventWithTiers([
      { name: 'General', price: 100, quantity: 10 },
    ], { vendorId: new mongoose.Types.ObjectId(vendorId) });

    const res = await sell({
      eventId, paymentMethod: 'cash', customerName: 'X', customerPhone: '+26878422613',
    });
    expect(res.status).toBe(400);
  });
});
