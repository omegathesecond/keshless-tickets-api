import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketPdfService } from '@services/ticketPdf.service';
import { Ticket } from '@models/ticket.model';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { EventStatus } from '@interfaces/event.interface';
import { signVendorToken } from '../../__tests__/helpers/auth';
import mongoose from 'mongoose';

let token = ''; let vendorId = ''; let eventId: mongoose.Types.ObjectId;

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
  jest.spyOn(TicketPdfService, 'buildTicketPdfBuffer').mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
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

it('streams the PDF bytes for the vendor own ticket', async () => {
  const t = await makeTicket(vendorId);
  const res = await request(app)
    .get(`/api/tickets/${t.ticketId}/pdf/download`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('application/pdf');
  expect(res.headers['content-disposition']).toContain('attachment');
});

it('refuses another vendor ticket and renders nothing', async () => {
  const other = await Vendor.create({
    businessName: 'Rival', email: 'rival@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  const t = await makeTicket(other._id.toString());
  const res = await request(app)
    .get(`/api/tickets/${t.ticketId}/pdf/download`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(403);
  expect(TicketPdfService.buildTicketPdfBuffer).not.toHaveBeenCalled();
});
