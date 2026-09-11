import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers } from '../../__tests__/helpers/fixtures';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { Ticket } from '@models/ticket.model';
import { Vendor } from '@models/vendor.model';
import { signVendorToken } from '../../__tests__/helpers/auth';
import mongoose from 'mongoose';

let token = ''; let vendorId = '';

beforeAll(connectTestDb);
beforeEach(async () => {
  await PaymentConfigService.update({ platformFeePercent: 0, cashEnabled: true });
  jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
  jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
  const v = await Vendor.create({
    businessName: 'Box Office Co', email: 'box@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  vendorId = v._id.toString();
  token = signVendorToken(vendorId, { permissions: ['tickets:sell_tickets'] });
});
afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
afterAll(disconnectTestDb);

const sell = (body: Record<string, unknown>) =>
  request(app).post('/api/tickets/sales/sell').set('Authorization', `Bearer ${token}`).send(body);

it('assigns each ticket its own recipient, in order', async () => {
  const { eventId, ticketTypeIds } = await seedEventWithTiers(
    [{ name: 'General', price: 100, quantity: 10 }],
    { vendorId: new mongoose.Types.ObjectId(vendorId) },
  );

  const res = await sell({
    eventId,
    items: [{
      ticketTypeId: ticketTypeIds[0], quantity: 3,
      recipients: [
        { name: 'Thandi', phone: '+26876111111' },
        { name: 'Sipho', email: 'Sipho@Example.com' },
      ],
    }],
    paymentMethod: 'cash',
    customerName: 'Walk-up', customerPhone: '+26878422613',
  });

  expect(res.status).toBe(201);
  const ids = res.body.data.tickets.map((t: any) => t._id);
  const tickets = await Ticket.find({ _id: { $in: ids } }).sort({ createdAt: 1 });

  expect(tickets[0]!.customerName).toBe('Thandi');
  expect(tickets[0]!.customerPhone).toBe('+26876111111');
  expect(tickets[1]!.customerName).toBe('Sipho');
  expect(tickets[1]!.customerEmail).toBe('sipho@example.com'); // lowercased
  // Third has no recipient entry -> falls back to the buyer, exactly as today.
  expect(tickets[2]!.customerName).toBe('Walk-up');
  expect(tickets[2]!.customerPhone).toBe('+26878422613');
});

it('omitting recipients reproduces current behaviour', async () => {
  const { eventId, ticketTypeIds } = await seedEventWithTiers(
    [{ name: 'General', price: 100, quantity: 10 }],
    { vendorId: new mongoose.Types.ObjectId(vendorId) },
  );
  const res = await sell({
    eventId,
    items: [{ ticketTypeId: ticketTypeIds[0], quantity: 2 }],
    paymentMethod: 'cash',
    customerName: 'Walk-up', customerPhone: '+26878422613',
  });
  expect(res.status).toBe(201);
  const tickets = await Ticket.find({ saleId: res.body.data.sale._id });
  expect(tickets).toHaveLength(2);
  for (const t of tickets) {
    expect(t.customerName).toBe('Walk-up');
    expect(t.customerPhone).toBe('+26878422613');
  }
});

it('rejects more recipients than the line quantity', async () => {
  const { eventId, ticketTypeIds } = await seedEventWithTiers(
    [{ name: 'General', price: 100, quantity: 10 }],
    { vendorId: new mongoose.Types.ObjectId(vendorId) },
  );
  const res = await sell({
    eventId,
    items: [{
      ticketTypeId: ticketTypeIds[0], quantity: 1,
      recipients: [{ name: 'A' }, { name: 'B' }],
    }],
    paymentMethod: 'cash',
    customerName: 'Walk-up', customerPhone: '+26878422613',
  });
  expect(res.status).toBe(400);
});
