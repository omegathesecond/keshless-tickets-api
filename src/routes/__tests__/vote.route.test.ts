import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';

const PHONE = '+26878422613';
const DAY_MS = 24 * 60 * 60 * 1000;

async function seedBuyer(phone = PHONE, name = 'Test Buyer') {
  return Buyer.create({ phone, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name });
}

/** A published event whose Vote window is already OPEN and not yet closed:
 *  published an hour ago, starting tomorrow (well inside the 7-day
 *  activation window, so opensAt collapses to publishedAt — see
 *  voteWindow.util's doc comment). */
async function seedOpenVoteEvent(vendorId = new mongoose.Types.ObjectId()) {
  const now = Date.now();
  const startTime = new Date(now + 1 * DAY_MS);
  const event = await Event.create({
    vendorId,
    name: 'Vote Route Test Event',
    venue: 'Test Venue',
    eventDate: startTime,
    startTime,
    endTime: new Date(startTime.getTime() + 3 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    publishedAt: new Date(now - 60 * 60 * 1000),
    ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 }],
  });
  return { eventId: event._id.toString(), vendorId: vendorId.toString() };
}

function organizerAuth(vendorId: string, extraPermissions: TicketsPermission[] = []) {
  return `Bearer ${signVendorToken(vendorId, { permissions: [TicketsPermission.VIEW_STATS, ...extraPermissions] })}`;
}

describe('Vote routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('401s a signed-out cast-vote attempt', async () => {
    const { eventId } = await seedOpenVoteEvent();
    await request(app)
      .post(`/api/public/events/${eventId}/vote/000000000000000000000000`)
      .send({ optionKey: 'friends' })
      .expect(401);
  });

  it('403s a non-owning organizer reading the Vote summary; the owning organizer succeeds (control)', async () => {
    const { eventId, vendorId } = await seedOpenVoteEvent();
    const otherVendorId = new mongoose.Types.ObjectId().toString();

    await request(app)
      .get(`/api/tickets/events/${eventId}/vote/summary`)
      .set('Authorization', organizerAuth(otherVendorId))
      .expect(403);

    await request(app)
      .get(`/api/tickets/events/${eventId}/vote/summary`)
      .set('Authorization', organizerAuth(vendorId))
      .expect(200);
  });

  it('casts a vote then reads it back with updated results (round trip)', async () => {
    const { eventId } = await seedOpenVoteEvent();
    await seedBuyer();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    // Materializes the event's Vote questions (lazy — first read wins).
    const before = await request(app).get(`/api/public/events/${eventId}/vote`).expect(200);
    const question = before.body.data.questions.find((q: any) => q.kind === 'attending_with');
    expect(question).toBeDefined();
    expect(question.viewerHasVoted).toBe(false);
    expect(question.results).toBeNull();

    const cast = await request(app)
      .post(`/api/public/events/${eventId}/vote/${question.id}`)
      .set('Authorization', auth)
      .send({ optionKey: 'friends' })
      .expect(200);

    expect(cast.body.data.viewerHasVoted).toBe(true);
    expect(cast.body.data.viewerSelection).toBe('friends');
    expect(cast.body.data.results.totalVotes).toBe(1);
    expect(cast.body.data.results.options.find((o: any) => o.key === 'friends').count).toBe(1);

    const after = await request(app)
      .get(`/api/public/events/${eventId}/vote`)
      .set('Authorization', auth)
      .expect(200);
    const afterQuestion = after.body.data.questions.find((q: any) => q.kind === 'attending_with');
    expect(afterQuestion.viewerHasVoted).toBe(true);
    expect(afterQuestion.viewerSelection).toBe('friends');
    expect(afterQuestion.results.totalVotes).toBe(1);
    expect(afterQuestion.results.leadingKey).toBe('friends');
  });
});
