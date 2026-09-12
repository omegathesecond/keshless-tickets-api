/**
 * POST /api/tickets/:ticketId/send — send ONE ticket to its own recipient.
 *
 * The ticket is the single source of truth for who receives it: this route
 * takes no recipient in the body. Callers PATCH /:ticketId/recipient first
 * (see vendorTicketRecipient.route.test.ts) to set the name/phone/email, then
 * call this route to actually dispatch it over SMS or email.
 */
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Ticket } from '@models/ticket.model';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketPdfStatus } from '@interfaces/ticket.interface';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { TicketPdfService } from '@services/ticketPdf.service';
import { signVendorToken } from '../../__tests__/helpers/auth';
import mongoose from 'mongoose';

let token = ''; let vendorId = ''; let eventId: mongoose.Types.ObjectId;
let smsSpy: jest.SpyInstance;
let emailSpy: jest.SpyInstance;

beforeAll(connectTestDb);
beforeEach(async () => {
  const v = await Vendor.create({
    businessName: 'Box Office Co', email: 'box@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  vendorId = v._id.toString();
  token = signVendorToken(vendorId, { permissions: ['tickets:sell_tickets'] });

  const future = new Date(Date.now() + 7 * 86400000);
  const ev = await Event.create({
    vendorId: v._id, name: 'Gig', venue: 'Hall',
    eventDate: future, startTime: future, endTime: new Date(future.getTime() + 7200000),
    status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0 }],
  });
  eventId = ev._id;

  smsSpy = jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
  emailSpy = jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
  // ensureTicketPdf uploads to real Cloudflare R2 when uncached — mock it here
  // (as vendorTicketPdf.route.test.ts mocks the PDF-generation innards) so the
  // suite never touches live infra or fails on missing R2_* env vars. Each
  // test gets a stable default; the pdf-link test below overrides it.
  jest.spyOn(TicketPdfService, 'ensureTicketPdf')
    .mockResolvedValue({ status: TicketPdfStatus.READY, pdfUrl: 'https://cdn.example/default.pdf' });
});
afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
afterAll(disconnectTestDb);

async function makeTicket(owner: string) {
  return Ticket.create({
    ticketId: `TKT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    saleId: new mongoose.Types.ObjectId(), eventId,
    vendorId: new mongoose.Types.ObjectId(owner),
    ticketType: 'General', price: 100, status: 'sold',
  });
}

const send = (ticketId: string, body: any, as = token) =>
  request(app).post(`/api/tickets/${ticketId}/send`)
    .set('Authorization', `Bearer ${as}`).send(body);

it('sends this ticket by SMS to its own recipient', async () => {
  const t = await makeTicket(vendorId);
  t.customerPhone = '+26876111111'; await t.save();

  const res = await send(t.ticketId, { channel: 'sms' });

  expect(res.status).toBe(200);
  expect(res.body.data.sent).toBe(true);
  expect(smsSpy).toHaveBeenCalledTimes(1);
  const [phone, summaries] = smsSpy.mock.calls[0]!;
  expect(phone).toBe('+26876111111');
  expect(summaries).toHaveLength(1);           // ONE ticket, not the whole sale
  expect(summaries[0].startTime).toBeTruthy(); // or the SMS prints 02:00
  expect(emailSpy).not.toHaveBeenCalled();
});

it('sends by email when that channel is chosen', async () => {
  const t = await makeTicket(vendorId);
  t.customerEmail = 'thandi@example.com'; await t.save();
  const res = await send(t.ticketId, { channel: 'email' });
  expect(res.status).toBe(200);
  expect(emailSpy).toHaveBeenCalledTimes(1);
  expect(smsSpy).not.toHaveBeenCalled();
});

it('refuses SMS when the ticket has no phone, and sends nothing', async () => {
  const t = await makeTicket(vendorId); // no customerPhone
  const res = await send(t.ticketId, { channel: 'sms' });
  expect(res.status).toBe(400);
  expect(smsSpy).not.toHaveBeenCalled();
});

it('surfaces a gateway rejection as 502', async () => {
  const t = await makeTicket(vendorId);
  t.customerPhone = '+26876111111'; await t.save();
  smsSpy.mockResolvedValue(false);
  const res = await send(t.ticketId, { channel: 'sms' });
  expect(res.status).toBe(502);
});

it('refuses another vendor ticket', async () => {
  const other = await Vendor.create({
    businessName: 'Rival', email: 'rival@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  const t = await makeTicket(other._id.toString());
  t.customerPhone = '+26876111111'; await t.save();
  const res = await send(t.ticketId, { channel: 'sms' });
  expect(res.status).toBe(403);
  expect(smsSpy).not.toHaveBeenCalled();
});

it('includes the ticket PDF link in the message', async () => {
  jest.spyOn(TicketPdfService, 'ensureTicketPdf')
    .mockResolvedValue({ status: TicketPdfStatus.READY, pdfUrl: 'https://cdn.example/t.pdf' });
  const t = await makeTicket(vendorId);
  t.customerPhone = '+26876111111'; await t.save();

  await send(t.ticketId, { channel: 'sms' });

  const [, summaries] = smsSpy.mock.calls[0]!;
  expect(summaries[0].pdfUrl).toBe('https://cdn.example/t.pdf');
});
