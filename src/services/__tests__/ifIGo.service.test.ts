import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { Story } from '@models/story.model';
import { IfIGoStory } from '@models/ifIGoStory.model';
import { IfIGoResponse } from '@models/ifIGoResponse.model';
import { Notification } from '@models/notification.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { BlockService } from '@services/block.service';
import { HttpError } from '@utils/httpError.util';
import {
  createIfIGoStory,
  finalizeIfIGoStory,
  getIfIGoStory,
  respondToIfIGoStory,
  removeIfIGoResponse,
  toggleResponses,
  listRespondents,
  updateResponseStatus,
  confirmTicketPurchase,
} from '@services/ifIGo.service';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@services/push.service', () => ({ PushService: { sendToBuyer: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('@utils/buyerOnline.util', () => ({ isBuyerOnline: jest.fn().mockResolvedValue(false) }));

// dispatchAsync (see notificationDispatcher.service#dispatchAsync) is
// deliberately fire-and-forget so a mutation's response is never slowed by
// notification fan-out — mirrors the same flush helper in
// notificationTriggers.test.ts for the exact same race.
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
}

const DAY_MS = 24 * 60 * 60 * 1000;
let phoneCounter = 0;
async function mkBuyer(username: string): Promise<IBuyer> {
  phoneCounter += 1;
  return Buyer.create({ phone: `+2687840${String(1000 + phoneCounter)}`, password: 'secret1', username }) as unknown as Promise<IBuyer>;
}

async function mkEvent(opts: { daysFromNow?: number } = {}) {
  const eventDate = new Date(Date.now() + (opts.daysFromNow ?? 5) * DAY_MS);
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Carrot Fest',
    venue: 'Mbabane Stadium',
    eventDate,
    startTime: eventDate,
    endTime: new Date(eventDate.getTime() + 3 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
  });
}

describe('ifIGo.service', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Story.init();
    await IfIGoStory.init();
    await IfIGoResponse.init();
    await Notification.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('createIfIGoStory / finalizeIfIGoStory', () => {
    it('publishes immediately (no media) and notifies followers exactly once', async () => {
      const creator = await mkBuyer('creator_a');
      const follower = await mkBuyer('follower_a');
      await Follow.create({ followerType: 'buyer', followerId: follower._id, targetType: 'buyer', targetId: creator._id });
      const event = await mkEvent();

      const result = await createIfIGoStory(creator, {
        eventId: String(event._id),
        options: [{ key: 'buy_ticket' }, { key: 'go_with_me' }],
      });
      expect(result.published).toBe(true);
      expect(result.uploadUrl).toBeNull();

      const story = await Story.findById(result.storyId);
      expect(story!.kind).toBe('if_i_go');
      expect(story!.media).toBeUndefined();
      expect(story!.background?.preset).toBeTruthy(); // default backdrop when no media

      const poll = await IfIGoStory.findById(result.ifIGoStoryId);
      expect(poll!.question).toBe('If I go to Carrot Fest, will you…?');

      const notifs = await Notification.find({ type: 'if_i_go_posted' });
      expect(notifs).toHaveLength(1);
      expect(String(notifs[0]!.recipientId)).toBe(String(follower._id));
    });

    it('holds publish (and the follower notification) until finalize when media is attached', async () => {
      const creator = await mkBuyer('creator_media');
      const follower = await mkBuyer('follower_media');
      await Follow.create({ followerType: 'buyer', followerId: follower._id, targetType: 'buyer', targetId: creator._id });
      const event = await mkEvent();

      const created = await createIfIGoStory(creator, {
        eventId: String(event._id),
        options: [{ key: 'buy_ticket' }, { key: 'meet_there' }],
        media: { kind: 'image', ext: 'jpg', contentType: 'image/jpeg' },
      });
      expect(created.published).toBe(false);
      expect(created.uploadUrl).toContain('https://r2.example/put');
      expect(await Notification.countDocuments({ type: 'if_i_go_posted' })).toBe(0);

      const result = await finalizeIfIGoStory(created.storyId, creator);
      expect(result.available).toBe(true);
      const story = await Story.findById(created.storyId);
      expect(story!.media!.status).toBe('ready');
      expect(await Notification.countDocuments({ type: 'if_i_go_posted' })).toBe(1);

      // Retrying finalize must not double-notify (spec §4 dedupe guard).
      await finalizeIfIGoStory(created.storyId, creator);
      expect(await Notification.countDocuments({ type: 'if_i_go_posted' })).toBe(1);
    });

    it('rejects a poll with fewer than 2 or more than 8 options', async () => {
      const creator = await mkBuyer('creator_opt');
      const event = await mkEvent();
      await expect(createIfIGoStory(creator, { eventId: String(event._id), options: [{ key: 'buy_ticket' }] })).rejects.toThrow(HttpError);
      const tooMany = Array.from({ length: 9 }, (_, i) => ({ label: `Option ${i}` }));
      await expect(createIfIGoStory(creator, { eventId: String(event._id), options: tooMany })).rejects.toThrow(HttpError);
    });

    it('rejects a past/started event', async () => {
      const creator = await mkBuyer('creator_past');
      const event = await mkEvent({ daysFromNow: -1 });
      await expect(
        createIfIGoStory(creator, { eventId: String(event._id), options: [{ key: 'buy_ticket' }, { key: 'go_with_me' }] })
      ).rejects.toThrow('upcoming event');
    });

    it('de-duplicates custom option labels that slugify to the same key', async () => {
      const creator = await mkBuyer('creator_custom');
      const event = await mkEvent();
      const result = await createIfIGoStory(creator, {
        eventId: String(event._id),
        options: [{ label: 'Bring snacks!' }, { label: 'Bring Snacks' }],
      });
      const poll = await IfIGoStory.findById(result.ifIGoStoryId);
      const keys = poll!.options.map((o) => o.key);
      expect(new Set(keys).size).toBe(2);
    });
  });

  describe('respondToIfIGoStory', () => {
    async function seedPoll(opts: { audience?: 'everyone' | 'followers'; allowMultiple?: boolean } = {}) {
      const creator = await mkBuyer(`creator_r_${Math.random().toString(36).slice(2, 8)}`);
      const event = await mkEvent();
      const created = await createIfIGoStory(creator, {
        eventId: String(event._id),
        options: [{ key: 'buy_ticket' }, { key: 'join_table' }, { key: 'go_with_me' }],
        audience: opts.audience,
        allowMultiple: opts.allowMultiple,
      });
      return { creator, event, storyId: created.storyId };
    }

    it('is idempotent under a repeated tap (upsert, no duplicate row)', async () => {
      const { storyId } = await seedPoll();
      const respondent = await mkBuyer('respondent_a');
      await respondToIfIGoStory(respondent, storyId, { optionKeys: ['buy_ticket'] });
      await respondToIfIGoStory(respondent, storyId, { optionKeys: ['buy_ticket'] });
      const poll = await IfIGoStory.findOne({ storyId });
      expect(await IfIGoResponse.countDocuments({ ifIGoStoryId: poll!._id })).toBe(1);
    });

    it('defaults status per option type (offered for buy_ticket, request_sent for join_table, interested for go_with_me)', async () => {
      const { storyId } = await seedPoll();
      const respondent = await mkBuyer('respondent_b');
      const result = await respondToIfIGoStory(respondent, storyId, { optionKeys: ['buy_ticket', 'join_table', 'go_with_me'], privateMessage: 'excited!' });
      expect(result.available).toBe(true);
      const byKey = new Map((result as any).poll.viewerSelections.map((s: any) => [s.optionKey, s.status]));
      expect(byKey.get('buy_ticket')).toBe('offered');
      expect(byKey.get('join_table')).toBe('request_sent');
      expect(byKey.get('go_with_me')).toBe('interested');
      expect((result as any).poll.viewerPrivateMessage).toBe('excited!');
    });

    it('rejects multiple selections when the poll only allows one', async () => {
      const { storyId } = await seedPoll({ allowMultiple: false });
      const respondent = await mkBuyer('respondent_c');
      await expect(respondToIfIGoStory(respondent, storyId, { optionKeys: ['buy_ticket', 'join_table'] })).rejects.toThrow('one response');
    });

    it('blocks a response from a blocked-either-way user', async () => {
      const { creator, storyId } = await seedPoll();
      const respondent = await mkBuyer('respondent_d');
      await BlockService.blockActor(String(creator._id), String(respondent._id));
      await expect(respondToIfIGoStory(respondent, storyId, { optionKeys: ['buy_ticket'] })).rejects.toThrow(HttpError);
    });

    it("'followers' audience rejects a non-follower and accepts a follower", async () => {
      const { creator, storyId } = await seedPoll({ audience: 'followers' });
      const stranger = await mkBuyer('stranger_e');
      await expect(respondToIfIGoStory(stranger, storyId, { optionKeys: ['buy_ticket'] })).rejects.toThrow('followers');

      const follower = await mkBuyer('follower_e');
      await Follow.create({ followerType: 'buyer', followerId: follower._id, targetType: 'buyer', targetId: creator._id });
      const result = await respondToIfIGoStory(follower, storyId, { optionKeys: ['buy_ticket'] });
      expect(result.available).toBe(true);
    });

    it('notifies the creator once per response event, never the respondent for their own poll', async () => {
      const { creator, storyId } = await seedPoll();
      const respondent = await mkBuyer('respondent_f');
      await respondToIfIGoStory(respondent, storyId, { optionKeys: ['buy_ticket', 'go_with_me'] });
      await flushAsync();
      const notifs = await Notification.find({ type: 'if_i_go_response', recipientId: creator._id });
      expect(notifs).toHaveLength(1);

      await respondToIfIGoStory(creator, storyId, { optionKeys: ['go_with_me'] });
      await flushAsync();
      expect(await Notification.countDocuments({ type: 'if_i_go_response', recipientId: creator._id })).toBe(1); // still just the one — no self-notify
    });

    it('rejects responses once the creator disables them', async () => {
      const { creator, storyId } = await seedPoll();
      await toggleResponses(creator, storyId, false);
      const respondent = await mkBuyer('respondent_g');
      await expect(respondToIfIGoStory(respondent, storyId, { optionKeys: ['buy_ticket'] })).rejects.toThrow('disabled');
    });

    it('removeIfIGoResponse deletes the row and results drop back to zero', async () => {
      const { storyId } = await seedPoll();
      const respondent = await mkBuyer('respondent_h');
      await respondToIfIGoStory(respondent, storyId, { optionKeys: ['buy_ticket'] });
      await removeIfIGoResponse(respondent, storyId);
      const view = await getIfIGoStory(storyId, null);
      expect(view.available).toBe(true);
      const ticketResult = (view as any).poll.results.find((r: any) => r.key === 'buy_ticket');
      expect(ticketResult.count).toBe(0);
    });
  });

  describe('public results aggregate — percentage of total participants, never per-respondent identity', () => {
    it('computes counts/percentages correctly and never leaks respondent identity to a non-creator viewer', async () => {
      const creator = await mkBuyer('creator_res');
      const event = await mkEvent();
      const created = await createIfIGoStory(creator, {
        eventId: String(event._id),
        options: [{ key: 'buy_ticket' }, { key: 'buy_drink' }],
        allowMultiple: true,
      });
      const a = await mkBuyer('res_a');
      const b = await mkBuyer('res_b');
      const c = await mkBuyer('res_c');
      await respondToIfIGoStory(a, created.storyId, { optionKeys: ['buy_ticket'] });
      await respondToIfIGoStory(b, created.storyId, { optionKeys: ['buy_ticket', 'buy_drink'] });
      await respondToIfIGoStory(c, created.storyId, { optionKeys: ['buy_drink'] });

      const outsider = await mkBuyer('outsider');
      const view = await getIfIGoStory(created.storyId, outsider);
      expect(view.available).toBe(true);
      const poll = (view as any).poll;
      expect(poll.totalParticipants).toBe(3);
      const ticket = poll.results.find((r: any) => r.key === 'buy_ticket');
      const drink = poll.results.find((r: any) => r.key === 'buy_drink');
      expect(ticket.count).toBe(2);
      expect(drink.count).toBe(2);
      expect(ticket.percentage).toBeCloseTo((2 / 3) * 100, 1);
      // Nothing in the public DTO carries a respondent id/name.
      expect(JSON.stringify(poll)).not.toContain(String(a._id));
      expect(JSON.stringify(poll)).not.toContain(String(b._id));
    });
  });

  describe('expiry — archived results visible only to the creator', () => {
    it('hides an expired poll from a non-creator but still shows the creator its frozen results', async () => {
      const creator = await mkBuyer('creator_exp');
      const event = await mkEvent();
      const created = await createIfIGoStory(creator, { eventId: String(event._id), options: [{ key: 'buy_ticket' }, { key: 'meet_there' }] });
      const respondent = await mkBuyer('respondent_exp');
      await respondToIfIGoStory(respondent, created.storyId, { optionKeys: ['buy_ticket'] });

      await IfIGoStory.updateOne({ storyId: created.storyId }, { expiresAt: new Date(Date.now() - 1000) });

      const outsiderView = await getIfIGoStory(created.storyId, respondent);
      expect(outsiderView.available).toBe(false);
      if (!outsiderView.available) expect(outsiderView.reason).toBe('expired');

      const creatorView = await getIfIGoStory(created.storyId, creator);
      expect(creatorView.available).toBe(true);
      if (creatorView.available) {
        expect(creatorView.poll.expired).toBe(true);
        expect(creatorView.poll.results.find((r) => r.key === 'buy_ticket')!.count).toBe(1);
      }
    });
  });

  describe('creator respondent view + status management', () => {
    it('listRespondents is creator-only and shows private message + status', async () => {
      const creator = await mkBuyer('creator_list');
      const event = await mkEvent();
      const created = await createIfIGoStory(creator, { eventId: String(event._id), options: [{ key: 'buy_drink' }, { key: 'meet_there' }] });
      const respondent = await mkBuyer('respondent_list');
      await respondToIfIGoStory(respondent, created.storyId, { optionKeys: ['buy_drink'], privateMessage: 'meet at the bar' });

      const outsider = await mkBuyer('outsider_list');
      await expect(listRespondents(outsider, created.storyId)).rejects.toThrow(HttpError);

      const rows = await listRespondents(creator, created.storyId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.privateMessage).toBe('meet at the bar');
      expect(rows[0]!.selections[0]!.status).toBe('offered');
    });

    it('updateResponseStatus is creator-only, restricted to accepted/declined/completed, and notifies the respondent', async () => {
      const creator = await mkBuyer('creator_status');
      const event = await mkEvent();
      const created = await createIfIGoStory(creator, { eventId: String(event._id), options: [{ key: 'join_table' }, { key: 'meet_there' }] });
      const respondent = await mkBuyer('respondent_status');
      await respondToIfIGoStory(respondent, created.storyId, { optionKeys: ['join_table'] });

      const outsider = await mkBuyer('outsider_status');
      await expect(updateResponseStatus(outsider, created.storyId, String(respondent._id), 'join_table', 'accepted')).rejects.toThrow(HttpError);
      await expect(updateResponseStatus(creator, created.storyId, String(respondent._id), 'join_table', 'interested' as any)).rejects.toThrow(HttpError);

      await updateResponseStatus(creator, created.storyId, String(respondent._id), 'join_table', 'accepted');
      const rows = await listRespondents(creator, created.storyId);
      expect(rows[0]!.selections[0]!.status).toBe('accepted');
      await flushAsync();
      expect(await Notification.countDocuments({ type: 'if_i_go_status_changed', recipientId: respondent._id })).toBe(1);

      // Creator-set status is never visible in public results (still just a count).
      const view = await getIfIGoStory(created.storyId, null);
      expect((view as any).poll.results.find((r: any) => r.key === 'join_table').count).toBe(1);
    });
  });

  describe('confirmTicketPurchase — read-only verification, fails loudly rather than faking success', () => {
    it('throws when no real ticket exists yet, and flips status only once one genuinely does', async () => {
      const creator = await mkBuyer('creator_tix');
      const event = await mkEvent();
      const created = await createIfIGoStory(creator, { eventId: String(event._id), options: [{ key: 'buy_ticket' }, { key: 'meet_there' }] });
      const respondent = await mkBuyer('respondent_tix');
      await respondToIfIGoStory(respondent, created.storyId, { optionKeys: ['buy_ticket'] });

      await expect(confirmTicketPurchase(respondent, created.storyId)).rejects.toThrow('No completed ticket purchase');

      await Ticket.create({
        eventId: event._id,
        vendorId: event.vendorId,
        buyerId: respondent._id,
        ticketType: 'General',
        price: 100,
        status: TicketStatus.SOLD,
      });

      const result = await confirmTicketPurchase(respondent, created.storyId);
      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.poll.viewerSelections.find((s) => s.optionKey === 'buy_ticket')!.status).toBe('completed');
      }
    });
  });
});
