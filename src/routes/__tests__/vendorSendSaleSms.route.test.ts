/**
 * POST /api/tickets/sales/:saleId/send-sms — the organizer/box-office (re)send.
 *
 * `sellTickets` notifies nobody at sale time, so for a walk-up sale this route
 * is the only way the buyer ever receives their ticket digitally. Before it
 * existed the dashboard button called the RESELLER route with an organizer
 * session and got "No authorization header provided".
 */
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers } from '../../__tests__/helpers/fixtures';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { Vendor } from '@models/vendor.model';
import { signVendorToken } from '../../__tests__/helpers/auth';
import mongoose from 'mongoose';

let token = '';
let vendorId = '';
let smsSpy: jest.SpyInstance;

beforeAll(connectTestDb);
beforeEach(async () => {
  await PaymentConfigService.update({ platformFeePercent: 0, cashEnabled: true });
  smsSpy = jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
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

/** Sell two tickets as `asToken`'s vendor and return the sale id. */
async function sellSale(asToken: string, owner: string, phone = '+26878422613') {
  const { eventId, ticketTypeIds } = await seedEventWithTiers(
    [{ name: 'General', price: 100, quantity: 10 }],
    { vendorId: new mongoose.Types.ObjectId(owner) },
  );
  const res = await request(app)
    .post('/api/tickets/sales/sell')
    .set('Authorization', `Bearer ${asToken}`)
    .send({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0], quantity: 2 }],
      paymentMethod: 'cash',
      customerName: 'Walk-up',
      customerPhone: phone,
    });
  expect(res.status).toBe(201);
  return res.body.data.sale._id as string;
}

const sendSms = (saleId: string, asToken: string) =>
  request(app)
    .post(`/api/tickets/sales/${saleId}/send-sms`)
    .set('Authorization', `Bearer ${asToken}`)
    .send();

describe('POST /api/tickets/sales/:saleId/send-sms', () => {
  it('sends the confirmation for the calling vendor own sale', async () => {
    const saleId = await sellSale(token, vendorId);
    smsSpy.mockClear();

    const res = await sendSms(saleId, token);

    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(true);
    expect(smsSpy).toHaveBeenCalledTimes(1);

    const [phone, summaries] = smsSpy.mock.calls[0]!;
    expect(phone).toBe('+26878422613');
    expect(summaries).toHaveLength(2);
    // startTime is the authoritative instant. Without it the SMS formats the
    // clock off eventDate (midnight UTC) and every ticket reads 02:00.
    expect(summaries[0].startTime).toBeTruthy();
    expect(summaries[0].eventName).toBeTruthy();
  });

  it('refuses a sale belonging to another vendor and sends nothing', async () => {
    const other = await Vendor.create({
      businessName: 'Rival Co', email: 'rival@example.com',
      password: 'Password1!', isActive: true, isVerified: true,
    });
    const otherToken = signVendorToken(other._id.toString(), {
      permissions: ['tickets:sell_tickets'],
    });
    const saleId = await sellSale(otherToken, other._id.toString());
    smsSpy.mockClear();

    const res = await sendSms(saleId, token);

    expect(res.status).toBe(403);
    expect(smsSpy).not.toHaveBeenCalled();
  });

  it('surfaces a gateway rejection as 502 rather than a successful-looking 200', async () => {
    const saleId = await sellSale(token, vendorId);
    smsSpy.mockClear();
    smsSpy.mockResolvedValue(false);

    const res = await sendSms(saleId, token);

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
  });

  it('404s an unknown sale', async () => {
    const res = await sendSms(new mongoose.Types.ObjectId().toString(), token);
    expect(res.status).toBe(404);
  });

  it('rejects a malformed sale id', async () => {
    const res = await sendSms('not-an-object-id', token);
    expect(res.status).toBe(400);
  });

  it('401s without a token — the dashboard bug that started this', async () => {
    const saleId = await sellSale(token, vendorId);
    const res = await request(app).post(`/api/tickets/sales/${saleId}/send-sms`).send();
    expect(res.status).toBe(401);
  });
});
