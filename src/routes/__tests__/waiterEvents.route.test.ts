import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { WAITER_PERMISSIONS, WaiterPermission } from '@interfaces/waiter.interface';
import { Waiter } from '@models/waiter.model';
import { OperatorGrant } from '@interfaces/operatorGrant.interface';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

let waiterSeq = 0;

/**
 * The Waiter ROW is real, not just the token: the event scope is re-resolved
 * from that row on every request, so a token naming no row is refused.
 */
async function seed() {
  const vendorId = new mongoose.Types.ObjectId();
  const future = new Date(Date.now() + 7 * 864e5);
  const event = await Event.create({
    vendorId, name: 'Fest', venue: 'V', eventDate: future, startTime: future,
    endTime: future, status: EventStatus.PUBLISHED, cashless: true, ticketTypes: [],
  });
  const waiter = await Waiter.create({
    fullName: 'Thabo', loginCode: `WTRE${waiterSeq++}`, pin: '123456',
    scope: 'organizer', vendorId, eventId: event._id,
  });
  const token = jwt.sign({
    scope: 'waiter', userType: 'waiter', waiterId: String(waiter._id),
    role: 'waiter', permissions: WAITER_PERMISSIONS, isSuperAdmin: false,
    fullName: 'Thabo', vendorId: String(vendorId), eventId: String(event._id),
  }, JWT_SECRET);
  return { eventId: String(event._id), token, waiterId: String(waiter._id) };
}

describe('the waiter floor screen', () => {
  it('lists the event this waiter works', async () => {
    const { eventId, token } = await seed();
    const res = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.events.map((e: any) => e.id)).toEqual([eventId]);
  });

  it('401s without a waiter token', async () => {
    await seed();
    const res = await request(app).get('/api/waiter/events');
    expect(res.status).toBe(401);
  });

  it('401s a cashier token — the scope claim is not interchangeable', async () => {
    await seed();
    const cashierToken = jwt.sign({ scope: 'cashier', userType: 'cashier' }, JWT_SECRET);
    const res = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${cashierToken}`);
    expect(res.status).toBe(401);
  });

  it('authorises from the ROW, not the token — an empty permissions claim still works', async () => {
    // The token's `permissions` is the POS's rendering copy; the row is what
    // authorizes (see authenticateWaiter). A waiter carrying a stale or
    // hand-emptied claim still holds the role floor, because the row does.
    // This is the merchant-side contract, arrived at for the same reason:
    // tokens live 7 days, so nothing a grant change must reach can be read
    // off them.
    const { eventId, waiterId } = await seed();
    const token = jwt.sign({
      scope: 'waiter', userType: 'waiter', waiterId,
      role: 'waiter', permissions: [], isSuperAdmin: false,
      fullName: 'Thabo', eventId,
    }, JWT_SECRET);
    const res = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('401s a waiter fired mid-shift, without waiting for the token to expire', async () => {
    const { token, waiterId } = await seed();
    await Waiter.findByIdAndUpdate(waiterId, { isActive: false });
    const res = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('401s a token naming a waiter row that no longer exists', async () => {
    const { token, waiterId } = await seed();
    await Waiter.findByIdAndDelete(waiterId);
    const res = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('answers with the LIVE permission set, so the POS renders from the row', async () => {
    // The bug this covers: the organizer flips "Settling on" in the dashboard
    // and nothing changes on the handheld, because the app was deciding from
    // its own 7-day-old token. The floor screen asks the server instead.
    const { token, waiterId } = await seed();

    const before = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${token}`);
    expect(before.body.data.permissions).toEqual(
      expect.arrayContaining([WaiterPermission.VIEW_EVENTS, WaiterPermission.MANAGE_TABLES]),
    );
    expect(before.body.data.permissions).not.toContain(WaiterPermission.SETTLE_TABLES);

    await Waiter.findByIdAndUpdate(waiterId, { grants: [OperatorGrant.SETTLE_TABLES] });

    const after = await request(app).get('/api/waiter/events')
      .set('Authorization', `Bearer ${token}`);
    expect(after.body.data.permissions).toContain(WaiterPermission.SETTLE_TABLES);
  });
});
