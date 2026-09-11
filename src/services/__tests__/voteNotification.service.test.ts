jest.mock('@services/push.service', () => ({
  PushService: { sendToBuyer: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@utils/buyerOnline.util', () => ({
  isBuyerOnline: jest.fn().mockResolvedValue(true),
  PRESENCE_STALE_MS: 120000,
}));
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { EventReaction } from '@models/eventReaction.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { Notification } from '@models/notification.model';
import { VoteQuestion } from '@models/voteQuestion.model';
import { VoteNotificationService } from '@services/voteNotification.service';

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedOpenEvent(startInDays: number, publishedDaysAgo: number) {
  const now = Date.now();
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Vote Notify Event',
    venue: 'Test Venue',
    eventDate: new Date(now + startInDays * DAY_MS),
    startTime: new Date(now + startInDays * DAY_MS),
    endTime: new Date(now + startInDays * DAY_MS + 3 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    publishedAt: new Date(now - publishedDaysAgo * DAY_MS),
  });
}

describe('VoteNotificationService.sweep', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Notification.init(); // partial unique dedupe indexes must exist before the re-sweep test below
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('notifies a ticket holder once when the Vote opens, and never again on re-sweep', async () => {
    const event = await seedOpenEvent(5, 10); // opened 2 days ago (T-7d), not closed
    const holder = await Buyer.create({ phone: '+26878700001', password: 'secret1', username: 'holder_a' });
    await Ticket.create({ eventId: event._id, vendorId: event.vendorId, ticketType: 'General', price: 100, customerPhone: '+26878700001', status: TicketStatus.SOLD });

    await VoteNotificationService.sweep();
    await VoteNotificationService.sweep(); // idempotent

    const notes = await Notification.find({ recipientId: holder._id, type: 'vote_opened' });
    expect(notes).toHaveLength(1);
    expect(String(notes[0]!.data['eventId'])).toBe(String(event._id));
    expect(await VoteQuestion.countDocuments({ eventId: event._id })).toBeGreaterThan(0); // materialized as a side effect
  });

  it('notifies a buyer who saved the event, deduped from a ticket holder also saving it', async () => {
    const event = await seedOpenEvent(5, 10);
    const saver = await Buyer.create({ phone: '+26878700002', password: 'secret1', username: 'saver_a' });
    await EventReaction.create({ eventId: event._id, buyerId: saver._id, actorType: 'buyer', type: 'save' });
    await Ticket.create({ eventId: event._id, vendorId: event.vendorId, ticketType: 'General', price: 100, customerPhone: '+26878700002', status: TicketStatus.SOLD });

    await VoteNotificationService.sweep();
    expect(await Notification.countDocuments({ recipientId: saver._id, type: 'vote_opened' })).toBe(1); // one row, not two
  });

  it('sends the one-time reminder only inside the 24h-before-close window', async () => {
    const farFromClose = await seedOpenEvent(5, 10); // closes in 5 days — no reminder yet
    const nearClose = await seedOpenEvent(0.5, 10); // closes in 12h — reminder window
    const buyer = await Buyer.create({ phone: '+26878700003', password: 'secret1', username: 'saver_b' });
    await EventReaction.create({ eventId: farFromClose._id, buyerId: buyer._id, actorType: 'buyer', type: 'save' });
    await EventReaction.create({ eventId: nearClose._id, buyerId: buyer._id, actorType: 'buyer', type: 'save' });

    await VoteNotificationService.sweep();

    expect(await Notification.countDocuments({ recipientId: buyer._id, type: 'vote_reminder', 'data.eventId': String(farFromClose._id) })).toBe(0);
    expect(await Notification.countDocuments({ recipientId: buyer._id, type: 'vote_reminder', 'data.eventId': String(nearClose._id) })).toBe(1);
  });

  it('never notifies for an event whose Vote has not opened or has already closed', async () => {
    const notYet = await seedOpenEvent(20, 1); // opens in 13 more days
    const closed = await seedOpenEvent(-1, 10); // already started
    const buyer = await Buyer.create({ phone: '+26878700004', password: 'secret1', username: 'saver_c' });
    await EventReaction.create({ eventId: notYet._id, buyerId: buyer._id, actorType: 'buyer', type: 'save' });
    await EventReaction.create({ eventId: closed._id, buyerId: buyer._id, actorType: 'buyer', type: 'save' });

    await VoteNotificationService.sweep();
    expect(await Notification.countDocuments({ type: { $in: ['vote_opened', 'vote_reminder'] } })).toBe(0);
  });
});
