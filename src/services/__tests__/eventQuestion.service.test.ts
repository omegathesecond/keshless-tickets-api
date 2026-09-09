import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Event } from '@models/event.model';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { EventQuestion } from '@models/eventQuestion.model';
import { EventQuestionReply } from '@models/eventQuestionReply.model';
import {
  listQuestions,
  listRecent,
  getQuestion,
  createQuestion,
  createReply,
  toggleQuestionLike,
  joinQuestion,
  leaveQuestion,
  getGeneralChatSummary,
} from '@services/eventQuestion.service';
import { EventQuestionMember } from '@models/eventQuestionMember.model';
import { HttpError } from '@utils/httpError.util';
import type { SocialActor } from '@utils/socialActor.util';

async function seedBuyer(overrides: Partial<{ phone: string; name: string; username: string; avatarUrl: string }> = {}) {
  return Buyer.create({
    phone: overrides.phone ?? '+26878422613',
    password: 'secret1',
    name: overrides.name ?? 'Test Buyer',
    username: overrides.username,
    avatarUrl: overrides.avatarUrl,
  });
}

async function seedVendor(overrides: Partial<{ businessName: string; logoUrl: string }> = {}) {
  return Vendor.create({
    businessName: overrides.businessName ?? 'Test Organizer',
    password: 'secret123',
    logoUrl: overrides.logoUrl,
  });
}

describe('eventQuestion.service', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('createQuestion', () => {
    it('throws 400 for an empty body', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      await expect(createQuestion(eventId, actor, '   ')).rejects.toThrow(HttpError);
      await expect(createQuestion(eventId, actor, '')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('throws 400 (not 500) for a body over 1000 chars', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      await expect(createQuestion(eventId, actor, 'a'.repeat(1001))).rejects.toMatchObject({ statusCode: 400 });
    });

    it('throws 404 for a non-existent event', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const fakeEventId = new mongoose.Types.ObjectId().toString();
      await expect(createQuestion(fakeEventId, actor, 'Is parking free?')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 403 for a suspended buyer actor', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await Buyer.create({ phone: '+26878400020', password: 'secret1', name: 'Suspended', socialSuspendedAt: new Date() });
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      await expect(createQuestion(eventId, actor, 'Hello?')).rejects.toMatchObject({
        statusCode: 403,
        message: 'Your community access is suspended',
      });
    });

    it('creates and returns a question with the buyer author DTO', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer({ name: 'Nomsa', username: 'nomsa_k', avatarUrl: 'https://cdn/n.png' });
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };

      const q = await createQuestion(eventId, actor, 'What time do doors open?');

      expect(q.eventId).toBe(eventId);
      expect(q.body).toBe('What time do doors open?');
      expect(q.likeCount).toBe(0);
      expect(q.replyCount).toBe(0);
      expect(q.author).toEqual({
        type: 'buyer',
        id: String(buyer._id),
        name: 'Nomsa',
        username: 'nomsa_k',
        avatarUrl: 'https://cdn/n.png',
      });

      expect(await EventQuestion.countDocuments({ eventId })).toBe(1);
    });

    it('creates and returns a question with the organizer author DTO for a vendor actor', async () => {
      const { eventId, vendorId } = await seedPublishedEvent();
      const vendor = await Vendor.findByIdAndUpdate(
        vendorId,
        { businessName: 'House on Fire', logoUrl: 'https://cdn/logo.png' },
        { new: true, upsert: true },
      );
      const actor: SocialActor = { type: 'vendor', id: String(vendor!._id) };

      const q = await createQuestion(eventId, actor, 'Gates open at 6pm.');

      expect(q.author).toEqual({
        type: 'organizer',
        id: String(vendor!._id),
        name: 'House on Fire',
        avatarUrl: 'https://cdn/logo.png',
      });
    });
  });

  describe('createReply', () => {
    it('throws 400 for an empty body', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: 'Q1' });
      await expect(createReply(question.id, actor, '')).rejects.toMatchObject({ statusCode: 400 });
    });

    it('throws 400 (not 500) for a body over 1000 chars', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: 'Q1' });
      await expect(createReply(question.id, actor, 'a'.repeat(1001))).rejects.toMatchObject({ statusCode: 400 });
    });

    it('throws 404 for a non-existent question', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      const fakeQuestionId = new mongoose.Types.ObjectId().toString();
      await expect(createReply(fakeQuestionId, actor, 'Reply body')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('throws 403 for a suspended buyer actor', async () => {
      const { eventId } = await seedPublishedEvent();
      const asker = await seedBuyer({ phone: '+26878400021', name: 'Asker' });
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: asker._id, body: 'Q1' });
      const suspended = await Buyer.create({ phone: '+26878400022', password: 'secret1', name: 'Suspended', socialSuspendedAt: new Date() });
      const actor: SocialActor = { type: 'buyer', id: String(suspended._id) };
      // Suspension is checked before membership, so a suspended non-member
      // actor must still see the suspension error, not "join this topic".
      await expect(createReply(question.id, actor, 'A reply')).rejects.toMatchObject({
        statusCode: 403,
        message: 'Your community access is suspended',
      });
    });

    it('throws 403 asking a non-member to join before replying', async () => {
      const { eventId } = await seedPublishedEvent();
      const asker = await seedBuyer({ phone: '+26878400024', name: 'Asker' });
      const stranger = await seedBuyer({ phone: '+26878400025', name: 'Stranger' });
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: asker._id, body: 'Q1' });
      await expect(createReply(question.id, { type: 'buyer', id: String(stranger._id) }, 'A reply')).rejects.toMatchObject({
        statusCode: 403,
        message: 'Join this topic to participate in the conversation.',
      });
    });

    it("lets the topic's own author reply without explicitly joining", async () => {
      const { eventId } = await seedPublishedEvent();
      const asker = await seedBuyer({ phone: '+26878400026', name: 'Asker' });
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: asker._id, body: 'Q1' });
      const reply = await createReply(question.id, { type: 'buyer', id: String(asker._id) }, 'Following up on my own question');
      expect(reply.body).toBe('Following up on my own question');
    });

    it('creates a reply, increments replyCount, and returns the author DTO', async () => {
      const { eventId } = await seedPublishedEvent();
      const asker = await seedBuyer({ phone: '+26878400001', name: 'Asker' });
      const replier = await seedBuyer({ phone: '+26878400002', name: 'Replier', username: 'replier_1' });
      const question = await EventQuestion.create({
        eventId, authorType: 'buyer', authorId: asker._id, body: 'When do gates open?',
      });
      const replierActor: SocialActor = { type: 'buyer', id: String(replier._id) };
      await joinQuestion(question.id, replierActor);

      const reply = await createReply(question.id, replierActor, 'At 6pm!');

      expect(reply.body).toBe('At 6pm!');
      expect(reply.questionId).toBe(question.id);
      expect(reply.author).toEqual({
        type: 'buyer', id: String(replier._id), name: 'Replier', username: 'replier_1', avatarUrl: null,
      });

      const updated = await EventQuestion.findById(question.id);
      expect(updated!.replyCount).toBe(1);
    });
  });

  describe('toggleQuestionLike', () => {
    it('toggles a like on then off, keeping the counter in sync', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: 'Q1' });
      const liker = await seedBuyer({ phone: '+26878400005', name: 'Liker' });
      const actor: SocialActor = { type: 'buyer', id: String(liker._id) };
      await joinQuestion(question.id, actor);

      const on = await toggleQuestionLike(question.id, actor);
      expect(on).toEqual({ active: true, likeCount: 1 });

      const off = await toggleQuestionLike(question.id, actor);
      expect(off).toEqual({ active: false, likeCount: 0 });
    });

    it('throws 403 asking a non-member to join before reacting', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: 'Q1' });
      const stranger = await seedBuyer({ phone: '+26878400027', name: 'Stranger' });
      await expect(toggleQuestionLike(question.id, { type: 'buyer', id: String(stranger._id) })).rejects.toMatchObject({
        statusCode: 403,
        message: 'Join this topic to participate in the conversation.',
      });
    });

    it('throws 403 for a suspended buyer actor', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: 'Q1' });
      const suspended = await Buyer.create({ phone: '+26878400023', password: 'secret1', name: 'Suspended', socialSuspendedAt: new Date() });
      const actor: SocialActor = { type: 'buyer', id: String(suspended._id) };
      await expect(toggleQuestionLike(question.id, actor)).rejects.toMatchObject({
        statusCode: 403,
        message: 'Your community access is suspended',
      });
    });

    it('throws 404 for a non-existent question', async () => {
      const fakeQuestionId = new mongoose.Types.ObjectId().toString();
      const actor: SocialActor = { type: 'buyer', id: new mongoose.Types.ObjectId().toString() };
      await expect(toggleQuestionLike(fakeQuestionId, actor)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('listQuestions', () => {
    it('returns an empty list for an event with no questions', async () => {
      const { eventId } = await seedPublishedEvent();
      expect(await listQuestions(eventId, null)).toEqual([]);
    });

    it('lists questions newest-first, each with replies oldest-first and viewerHasLiked defaulted false', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };

      const first = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: 'First question' });
      await new Promise((r) => setTimeout(r, 5));
      const second = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: 'Second question' });

      await EventQuestionReply.create({ questionId: first.id, eventId, authorType: 'buyer', authorId: buyer._id, body: 'Reply A' });
      await new Promise((r) => setTimeout(r, 5));
      await EventQuestionReply.create({ questionId: first.id, eventId, authorType: 'buyer', authorId: buyer._id, body: 'Reply B' });

      const list = await listQuestions(eventId, actor);

      expect(list.map((q: any) => q.id)).toEqual([second.id, first.id]);
      expect(list[0].viewerHasLiked).toBe(false);
      expect(list[1].replies.map((r: any) => r.body)).toEqual(['Reply A', 'Reply B']);
      expect(list[1].replies[0].author.type).toBe('buyer');
    });

    it('reports viewerHasLiked true only for a question the actor liked, and false with a null actor', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      const likerBuyer = await seedBuyer({ phone: '+26878400006', name: 'Liker' });
      const liker: SocialActor = { type: 'buyer', id: String(likerBuyer._id) };

      const liked = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: 'Liked question' });
      const notLiked = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: 'Not liked' });
      await joinQuestion(liked.id, liker);
      await toggleQuestionLike(liked.id, liker);

      const asLiker = await listQuestions(eventId, liker);
      const likedEntry = asLiker.find((q: any) => q.id === liked.id);
      const notLikedEntry = asLiker.find((q: any) => q.id === notLiked.id);
      expect(likedEntry.viewerHasLiked).toBe(true);
      expect(notLikedEntry.viewerHasLiked).toBe(false);

      const anon = await listQuestions(eventId, null);
      expect(anon.every((q: any) => q.viewerHasLiked === false)).toBe(true);
    });

    it('does not N+1: author lookups are batched into a bounded number of queries', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      for (let i = 0; i < 5; i++) {
        const q = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: `Q${i}` });
        await EventQuestionReply.create({ questionId: q.id, eventId, authorType: 'buyer', authorId: buyer._id, body: `R${i}` });
      }

      const findSpy = jest.spyOn(Buyer, 'find');
      await listQuestions(eventId, null);
      // One batch call for all question+reply authors together, not one per row.
      expect(findSpy).toHaveBeenCalledTimes(1);
      findSpy.mockRestore();
    });
  });

  describe('listRecent', () => {
    it('returns an empty list when there are no questions across any event', async () => {
      await seedPublishedEvent(); // an event exists, just no questions
      expect(await listRecent(null)).toEqual([]);
    });

    it('returns the most recent questions across events, newest first, each carrying its event { id, name }', async () => {
      const eventA = await seedPublishedEvent();
      await Event.findByIdAndUpdate(eventA.eventId, { name: 'Summer Jam' });
      const eventB = await seedPublishedEvent();
      await Event.findByIdAndUpdate(eventB.eventId, { name: 'Winter Fest' });
      const buyer = await seedBuyer();

      const q1 = await EventQuestion.create({
        eventId: eventA.eventId, authorType: 'buyer', authorId: buyer._id, body: 'Question on event A',
      });
      await new Promise((r) => setTimeout(r, 5));
      const q2 = await EventQuestion.create({
        eventId: eventB.eventId, authorType: 'buyer', authorId: buyer._id, body: 'Question on event B',
      });

      const list = await listRecent(null);

      expect(list.map((q: any) => q.id)).toEqual([q2.id, q1.id]);
      expect(list[0].event).toEqual({ id: eventB.eventId, name: 'Winter Fest', image: null });
      expect(list[1].event).toEqual({ id: eventA.eventId, name: 'Summer Jam', image: null });
    });

    it('hydrates author, replies (author DTO\'d), and viewerHasLiked exactly like listQuestions', async () => {
      const { eventId } = await seedPublishedEvent();
      const asker = await seedBuyer({ phone: '+26878400003', name: 'Asker' });
      const replier = await seedBuyer({ phone: '+26878400004', name: 'Replier', username: 'replier_2' });
      const likerBuyer = await seedBuyer({ phone: '+26878400007', name: 'Liker' });
      const liker: SocialActor = { type: 'buyer', id: String(likerBuyer._id) };

      const question = await EventQuestion.create({
        eventId, authorType: 'buyer', authorId: asker._id, body: 'When do gates open?',
      });
      const replierActor: SocialActor = { type: 'buyer', id: String(replier._id) };
      await joinQuestion(question.id, replierActor);
      await createReply(question.id, replierActor, 'At 6pm!');
      await joinQuestion(question.id, liker);
      await toggleQuestionLike(question.id, liker);

      const [entry] = await listRecent(liker);

      expect(entry.author).toEqual({
        type: 'buyer', id: String(asker._id), name: 'Asker', username: null, avatarUrl: null,
      });
      expect(entry.replies).toHaveLength(1);
      expect(entry.replies[0].author).toEqual({
        type: 'buyer', id: String(replier._id), name: 'Replier', username: 'replier_2', avatarUrl: null,
      });
      expect(entry.viewerHasLiked).toBe(true);
      expect(entry.likeCount).toBe(1);
      expect(entry.replyCount).toBe(1);

      const [anonEntry] = await listRecent(null);
      expect(anonEntry.viewerHasLiked).toBe(false);
    });

    it('respects the limit, still newest first', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const q = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: `Q${i}` });
        ids.push(q.id);
        await new Promise((r) => setTimeout(r, 5));
      }

      const list = await listRecent(null, 2);
      expect(list.map((q: any) => q.id)).toEqual([ids[2], ids[1]]);
    });

    it('does not N+1: event lookups are batched regardless of how many distinct events appear', async () => {
      const buyer = await seedBuyer();
      for (let i = 0; i < 4; i++) {
        const { eventId } = await seedPublishedEvent();
        await EventQuestion.create({ eventId, authorType: 'buyer', authorId: buyer._id, body: `Q${i}` });
      }

      const eventFindSpy = jest.spyOn(Event, 'find');
      await listRecent(null);
      expect(eventFindSpy).toHaveBeenCalledTimes(1);
      eventFindSpy.mockRestore();
    });
  });

  describe('getQuestion', () => {
    it('returns one hydrated question with its event block and replies', async () => {
      const { eventId } = await seedPublishedEvent();
      const asker = await seedBuyer({ phone: '+26878000100', name: 'Asker' });
      const replier = await seedBuyer({ phone: '+26878000101', name: 'Replier' });
      const q = await createQuestion(eventId, { type: 'buyer', id: String(asker._id) }, 'What should I wear?');
      const replierActor: SocialActor = { type: 'buyer', id: String(replier._id) };
      await joinQuestion(q.id, replierActor);
      await createReply(q.id, replierActor, 'Neon colours obviously');

      const detail = await getQuestion(q.id, null);
      expect(detail).toMatchObject({
        id: q.id,
        body: 'What should I wear?',
        event: { id: eventId, name: 'Snapshot Test Event' },
      });
      expect(detail.replies).toHaveLength(1);
      expect(detail.replies[0]).toMatchObject({ body: 'Neon colours obviously', author: { name: 'Replier' } });
    });

    it('returns null for a non-existent id (so the controller 404s, not 500s)', async () => {
      expect(await getQuestion(String(new mongoose.Types.ObjectId()), null)).toBeNull();
    });
  });

  describe('membership (join/leave/joinQuestion side effects)', () => {
    it('auto-joins the creator, so a fresh topic starts with memberCount 1 and viewerIsMember true', async () => {
      const { eventId } = await seedPublishedEvent();
      const buyer = await seedBuyer({ name: 'Nomsa' });
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };

      const q = await createQuestion(eventId, actor, 'Anyone else going?');

      expect(q.memberCount).toBe(1);
      expect(q.viewerIsMember).toBe(true);
      expect(q.members).toEqual([expect.objectContaining({ type: 'buyer', id: String(buyer._id), name: 'Nomsa' })]);

      const fetched = await getQuestion(q.id, actor);
      expect(fetched.memberCount).toBe(1);
      expect(fetched.viewerIsMember).toBe(true);
    });

    it('joinQuestion adds a member, bumps memberCount, and is idempotent on a repeated call', async () => {
      const { eventId } = await seedPublishedEvent();
      const author = await seedBuyer({ phone: '+26878400030', name: 'Author' });
      const joiner = await seedBuyer({ phone: '+26878400031', name: 'Joiner' });
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: author._id, body: 'Q1' });
      const actor: SocialActor = { type: 'buyer', id: String(joiner._id) };

      const first = await joinQuestion(question.id, actor);
      expect(first).toEqual({ memberCount: 1, viewerIsMember: true, members: [expect.objectContaining({ id: String(joiner._id) })] });

      const second = await joinQuestion(question.id, actor);
      expect(second.memberCount).toBe(1); // tapping Join again never creates a duplicate row
      expect(await EventQuestionMember.countDocuments({ questionId: question.id })).toBe(1);
    });

    it('leaveQuestion removes membership and is idempotent; a non-member leaving is a no-op', async () => {
      const { eventId } = await seedPublishedEvent();
      const author = await seedBuyer({ phone: '+26878400032', name: 'Author' });
      const member = await seedBuyer({ phone: '+26878400033', name: 'Member' });
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: author._id, body: 'Q1' });
      const actor: SocialActor = { type: 'buyer', id: String(member._id) };
      await joinQuestion(question.id, actor);

      const left = await leaveQuestion(question.id, actor);
      expect(left).toEqual({ memberCount: 0, viewerIsMember: false, members: [] });

      // Leaving again (already gone) must not throw.
      await expect(leaveQuestion(question.id, actor)).resolves.toEqual({ memberCount: 0, viewerIsMember: false, members: [] });
    });

    it('joinQuestion throws 404 for a non-existent topic', async () => {
      const buyer = await seedBuyer();
      const actor: SocialActor = { type: 'buyer', id: String(buyer._id) };
      await expect(joinQuestion(String(new mongoose.Types.ObjectId()), actor)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('caps the members preview at 4 but reports the real total count', async () => {
      const { eventId } = await seedPublishedEvent();
      const author = await seedBuyer({ phone: '+26878400040', name: 'Author' });
      const question = await EventQuestion.create({ eventId, authorType: 'buyer', authorId: author._id, body: 'Q1' });
      for (let i = 0; i < 5; i++) {
        const joiner = await seedBuyer({ phone: `+2687840005${i}`, name: `Joiner${i}` });
        await joinQuestion(question.id, { type: 'buyer', id: String(joiner._id) });
      }

      const detail = await getQuestion(question.id, null);
      expect(detail.memberCount).toBe(5);
      expect(detail.members).toHaveLength(4);
    });
  });

  describe('getGeneralChatSummary', () => {
    it('returns { memberCount: 0, members: [] } when nobody has joined any general topic', async () => {
      expect(await getGeneralChatSummary()).toEqual({ memberCount: 0, members: [] });
    });

    it('counts distinct actors across general topics only, never an event-scoped one', async () => {
      const { eventId } = await seedPublishedEvent();
      const alice = await seedBuyer({ phone: '+26878400060', name: 'Alice' });
      const bob = await seedBuyer({ phone: '+26878400061', name: 'Bob' });
      const aliceActor: SocialActor = { type: 'buyer', id: String(alice._id) };
      const bobActor: SocialActor = { type: 'buyer', id: String(bob._id) };

      // Alice joins a general topic (auto, as its creator) and an event-scoped one.
      const general = await createQuestion(null, aliceActor, 'Hey everyone!');
      await createQuestion(eventId, aliceActor, 'Event-scoped question');
      // Bob joins the same general topic explicitly.
      await joinQuestion(general.id, bobActor);

      const summary = await getGeneralChatSummary();
      expect(summary.memberCount).toBe(2);
      expect(summary.members.map((m) => m.id).sort()).toEqual([String(alice._id), String(bob._id)].sort());
    });
  });
});
