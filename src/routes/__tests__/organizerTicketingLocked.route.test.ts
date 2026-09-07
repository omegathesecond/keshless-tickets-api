// Carrot Tickets is always the seller for every organizer-created event —
// the dashboard no longer asks organizers to choose (see
// EventDetailsPage's Currency card), and the API must never let anything
// else through this path either, no matter what a client sends. This is
// deliberately enforced at the organizer controller layer rather than in
// createEventSchema/updateEventSchema, since that shared schema also backs
// the community self-listing submit path, where 'external' ticketing is a
// legitimate, unrelated choice (see communityEventSubmit.route.test.ts).
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';
const VENDOR_ID = '64c000000000000000000a01';

function token() {
  return jwt.sign({
    app: 'tickets', userType: 'vendor', role: 'tickets_owner',
    permissions: ['tickets:create_event', 'tickets:edit_event'], vendorId: VENDOR_ID,
  }, JWT_SECRET);
}

function futureIso(daysAhead: number, hour = 18): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

it('forces ticketing to carrot on create, ignoring an external request', async () => {
  const res = await request(app)
    .post('/api/tickets/events')
    .set('Authorization', `Bearer ${token()}`)
    .send({
      name: 'Rooftop Jam', venue: 'The Roof',
      eventDate: futureIso(10), startTime: futureIso(10, 18), endTime: futureIso(10, 23),
      ticketing: 'external', externalTicketUrl: 'https://organizer-owned.example.com/tickets',
    });

  expect(res.status).toBe(201);
  expect(res.body.data.ticketing).toBe('carrot');
  expect(res.body.data.externalTicketUrl).toBeFalsy();
});

it('rejects an update attempt to switch an event to external ticketing', async () => {
  const created = await request(app)
    .post('/api/tickets/events')
    .set('Authorization', `Bearer ${token()}`)
    .send({
      name: 'Block Party', venue: 'Main St',
      eventDate: futureIso(10), startTime: futureIso(10, 18), endTime: futureIso(10, 23),
    });
  expect(created.status).toBe(201);
  const eventId = created.body.data._id;

  const updated = await request(app)
    .put(`/api/tickets/events/${eventId}`)
    .set('Authorization', `Bearer ${token()}`)
    .send({ ticketing: 'external', externalTicketUrl: 'https://organizer-owned.example.com/tickets' });

  expect(updated.status).toBe(200);
  expect(updated.body.data.ticketing).toBe('carrot');
  expect(updated.body.data.externalTicketUrl).toBeFalsy();
});
