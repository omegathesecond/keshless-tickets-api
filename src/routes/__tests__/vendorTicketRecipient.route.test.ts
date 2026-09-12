import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Ticket } from '@models/ticket.model';
import { Vendor } from '@models/vendor.model';
import { signVendorToken } from '../../__tests__/helpers/auth';
import mongoose from 'mongoose';

let token = ''; let vendorId = '';

beforeAll(connectTestDb);
beforeEach(async () => {
  const v = await Vendor.create({
    businessName: 'Box Office Co', email: 'box@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  vendorId = v._id.toString();
  token = signVendorToken(vendorId, { permissions: ['tickets:sell_tickets'] });
});
afterEach(async () => { await clearTestDb(); });
afterAll(disconnectTestDb);

async function makeTicket(owner: string, status = 'sold') {
  return Ticket.create({
    ticketId: `TKT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    saleId: new mongoose.Types.ObjectId(),
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(owner),
    ticketType: 'General', price: 100, status, // model enum: available|sold|checked_in|refunded|cancelled
    customerName: 'Walk-up', customerPhone: '+26878422613',
  });
}

const patch = (ticketId: string, body: any, as = token) =>
  request(app).patch(`/api/tickets/${ticketId}/recipient`)
    .set('Authorization', `Bearer ${as}`).send(body);

it('sets the recipient on the vendor own ticket', async () => {
  const t = await makeTicket(vendorId);
  const res = await patch(t.ticketId, { name: 'Thandi', phone: '+26876111111' });
  expect(res.status).toBe(200);
  const fresh = await Ticket.findById(t._id);
  expect(fresh!.customerName).toBe('Thandi');
  expect(fresh!.customerPhone).toBe('+26876111111');
});

it('refuses a ticket belonging to another vendor', async () => {
  const other = await Vendor.create({
    businessName: 'Rival', email: 'rival@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  const t = await makeTicket(other._id.toString());
  const res = await patch(t.ticketId, { name: 'Nope' });
  expect(res.status).toBe(403);
  const fresh = await Ticket.findById(t._id);
  expect(fresh!.customerName).toBe('Walk-up');
});

it('refuses to reassign an already-scanned ticket', async () => {
  const t = await makeTicket(vendorId, 'checked_in');
  const res = await patch(t.ticketId, { name: 'Thandi' });
  expect(res.status).toBe(409);
});

it('404s an unknown ticket', async () => {
  const res = await patch('TKT-NOPE', { name: 'X' });
  expect(res.status).toBe(404);
});
