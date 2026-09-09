import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';

const PHONE = '+26878422613';

async function seedBuyer(phone = PHONE, name = 'Test Buyer') {
  return Buyer.create({ phone, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name });
}

async function seedSuspendedBuyer(phone = PHONE, name = 'Suspended Buyer') {
  return Buyer.create({ phone, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name, socialSuspendedAt: new Date() });
}

describe('event Q&A routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lets an anonymous caller GET an empty question list for a real event', async () => {
    const { eventId } = await seedPublishedEvent();
    const res = await request(app).get(`/api/community/${eventId}/questions`).expect(200);
    expect(res.body.data).toEqual([]);
  });

  it('401s an anonymous attempt to post a question', async () => {
    const { eventId } = await seedPublishedEvent();
    await request(app).post(`/api/community/${eventId}/questions`).send({ body: 'Hello?' }).expect(401);
  });

  it('400s an empty-body question from a signed-in buyer', async () => {
    const { eventId } = await seedPublishedEvent();
    await seedBuyer();
    await request(app)
      .post(`/api/community/${eventId}/questions`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ body: '   ' })
      .expect(400);
  });

  it('posts a question as a buyer, and it appears in GET with author + viewerHasLiked:false', async () => {
    const { eventId } = await seedPublishedEvent();
    await seedBuyer();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    const created = await request(app)
      .post(`/api/community/${eventId}/questions`)
      .set('Authorization', auth)
      .send({ body: 'What time do doors open?' })
      .expect(201);

    expect(created.body.data.body).toBe('What time do doors open?');
    expect(created.body.data.author.type).toBe('buyer');
    expect(created.body.data.viewerHasLiked).toBe(false);

    const list = await request(app)
      .get(`/api/community/${eventId}/questions`)
      .set('Authorization', auth)
      .expect(200);

    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].id).toBe(created.body.data.id);
    expect(list.body.data[0].author.name).toBe('Test Buyer');
    expect(list.body.data[0].viewerHasLiked).toBe(false);
    expect(list.body.data[0].replies).toEqual([]);
  });

  it('lets an organizer (vendor token) post a question too, tagged as an organizer author', async () => {
    const { eventId, vendorId } = await seedPublishedEvent();
    await Vendor.findByIdAndUpdate(vendorId, { businessName: 'House on Fire' }, { upsert: true });

    const created = await request(app)
      .post(`/api/community/${eventId}/questions`)
      .set('Authorization', `Bearer ${signVendorToken(vendorId)}`)
      .send({ body: 'Gates open at 6pm.' })
      .expect(201);

    expect(created.body.data.author).toEqual(
      expect.objectContaining({ type: 'organizer', name: 'House on Fire' }),
    );
  });

  it('404s posting a question against a non-existent event', async () => {
    await seedBuyer();
    await request(app)
      .post('/api/community/000000000000000000000000/questions')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ body: 'Anyone there?' })
      .expect(404);
  });

  it('401s an anonymous reply and like', async () => {
    const { eventId } = await seedPublishedEvent();
    await seedBuyer();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;
    const created = await request(app)
      .post(`/api/community/${eventId}/questions`)
      .set('Authorization', auth)
      .send({ body: 'Question body' })
      .expect(201);
    const questionId = created.body.data.id;

    await request(app).post(`/api/community/questions/${questionId}/replies`).send({ body: 'A reply' }).expect(401);
    await request(app).post(`/api/community/questions/${questionId}/like`).expect(401);
  });

  it('posts a reply that increments replyCount and appears under the question', async () => {
    const { eventId } = await seedPublishedEvent();
    await seedBuyer();
    const replier = await seedBuyer('+26878400002', 'Replier');
    const auth = `Bearer ${signBuyerToken(PHONE)}`;
    const replierAuth = `Bearer ${signBuyerToken('+26878400002')}`;

    const created = await request(app)
      .post(`/api/community/${eventId}/questions`)
      .set('Authorization', auth)
      .send({ body: 'When do gates open?' })
      .expect(201);
    const questionId = created.body.data.id;

    const replyRes = await request(app)
      .post(`/api/community/questions/${questionId}/replies`)
      .set('Authorization', replierAuth)
      .send({ body: 'At 6pm!' })
      .expect(201);

    expect(replyRes.body.data.body).toBe('At 6pm!');
    expect(replyRes.body.data.author).toEqual(
      expect.objectContaining({ type: 'buyer', id: String(replier._id), name: 'Replier' }),
    );

    const list = await request(app).get(`/api/community/${eventId}/questions`).expect(200);
    expect(list.body.data[0].replyCount).toBe(1);
    expect(list.body.data[0].replies).toHaveLength(1);
    expect(list.body.data[0].replies[0].body).toBe('At 6pm!');
  });

  it('400s an empty-body reply', async () => {
    const { eventId } = await seedPublishedEvent();
    await seedBuyer();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;
    const created = await request(app)
      .post(`/api/community/${eventId}/questions`)
      .set('Authorization', auth)
      .send({ body: 'Question body' })
      .expect(201);

    await request(app)
      .post(`/api/community/questions/${created.body.data.id}/replies`)
      .set('Authorization', auth)
      .send({ body: '' })
      .expect(400);
  });

  it('toggles a like on then off, flipping likeCount and viewerHasLiked', async () => {
    const { eventId } = await seedPublishedEvent();
    await seedBuyer();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;
    const created = await request(app)
      .post(`/api/community/${eventId}/questions`)
      .set('Authorization', auth)
      .send({ body: 'Question body' })
      .expect(201);
    const questionId = created.body.data.id;

    const liked = await request(app)
      .post(`/api/community/questions/${questionId}/like`)
      .set('Authorization', auth)
      .expect(200);
    expect(liked.body.data).toEqual({ active: true, likeCount: 1 });

    const afterLike = await request(app)
      .get(`/api/community/${eventId}/questions`)
      .set('Authorization', auth)
      .expect(200);
    expect(afterLike.body.data[0].viewerHasLiked).toBe(true);
    expect(afterLike.body.data[0].likeCount).toBe(1);

    const unliked = await request(app)
      .post(`/api/community/questions/${questionId}/like`)
      .set('Authorization', auth)
      .expect(200);
    expect(unliked.body.data).toEqual({ active: false, likeCount: 0 });

    const afterUnlike = await request(app)
      .get(`/api/community/${eventId}/questions`)
      .set('Authorization', auth)
      .expect(200);
    expect(afterUnlike.body.data[0].viewerHasLiked).toBe(false);
  });

  it('404s replying to and liking a non-existent question', async () => {
    await seedBuyer();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;
    await request(app)
      .post('/api/community/questions/000000000000000000000000/replies')
      .set('Authorization', auth)
      .send({ body: 'Reply body' })
      .expect(404);
    await request(app)
      .post('/api/community/questions/000000000000000000000000/like')
      .set('Authorization', auth)
      .expect(404);
  });

  describe('general "Chat with Everyone" posts (no event)', () => {
    it('401s an anonymous attempt to post a general question', async () => {
      await request(app).post('/api/community/questions').send({ body: 'Hey everyone!' }).expect(401);
    });

    it('400s an empty-body general post', async () => {
      await seedBuyer();
      await request(app)
        .post('/api/community/questions')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .send({ body: '   ' })
        .expect(400);
    });

    it('posts a general question with eventId: null, appears in the cross-event feed the same way', async () => {
      await seedBuyer();
      const auth = `Bearer ${signBuyerToken(PHONE)}`;

      const created = await request(app)
        .post('/api/community/questions')
        .set('Authorization', auth)
        .send({ body: 'Hey everyone, what a night!' })
        .expect(201);

      expect(created.body.data.eventId).toBeNull();
      expect(created.body.data.author.type).toBe('buyer');

      const recent = await request(app).get('/api/public/questions').set('Authorization', auth).expect(200);
      expect(recent.body.data.questions).toHaveLength(1);
      expect(recent.body.data.questions[0].id).toBe(created.body.data.id);
      expect(recent.body.data.questions[0].event).toBeNull();
    });

    it("doesn't appear under any specific event's Q&A list", async () => {
      const { eventId } = await seedPublishedEvent();
      await seedBuyer();
      const auth = `Bearer ${signBuyerToken(PHONE)}`;
      await request(app).post('/api/community/questions').set('Authorization', auth).send({ body: 'General post' }).expect(201);

      const eventList = await request(app).get(`/api/community/${eventId}/questions`).expect(200);
      expect(eventList.body.data).toEqual([]);
    });

    it('supports reply and like on a general post, same as an event-scoped one', async () => {
      await seedBuyer();
      const auth = `Bearer ${signBuyerToken(PHONE)}`;
      const created = await request(app)
        .post('/api/community/questions')
        .set('Authorization', auth)
        .send({ body: 'General post' })
        .expect(201);
      const questionId = created.body.data.id;

      const replyRes = await request(app)
        .post(`/api/community/questions/${questionId}/replies`)
        .set('Authorization', auth)
        .send({ body: 'Replying to everyone' })
        .expect(201);
      expect(replyRes.body.data.eventId).toBeNull();

      const liked = await request(app)
        .post(`/api/community/questions/${questionId}/like`)
        .set('Authorization', auth)
        .expect(200);
      expect(liked.body.data).toEqual({ active: true, likeCount: 1 });

      const single = await request(app).get(`/api/community/questions/${questionId}`).set('Authorization', auth).expect(200);
      expect(single.body.data.event).toBeNull();
      expect(single.body.data.replies).toHaveLength(1);
      expect(single.body.data.viewerHasLiked).toBe(true);
    });
  });

  describe('social suspension enforcement', () => {
    const OK_PHONE = '+26878400010';
    const SUSPENDED_PHONE = '+26878400011';

    it('403s a suspended buyer posting a question; a non-suspended buyer still succeeds (control)', async () => {
      const { eventId } = await seedPublishedEvent();
      await seedSuspendedBuyer(SUSPENDED_PHONE, 'Suspended Poster');
      await seedBuyer(OK_PHONE, 'OK Poster');

      await request(app)
        .post(`/api/community/${eventId}/questions`)
        .set('Authorization', `Bearer ${signBuyerToken(SUSPENDED_PHONE)}`)
        .send({ body: 'Hello?' })
        .expect(403);

      await request(app)
        .post(`/api/community/${eventId}/questions`)
        .set('Authorization', `Bearer ${signBuyerToken(OK_PHONE)}`)
        .send({ body: 'Hello?' })
        .expect(201);
    });

    it('403s a suspended buyer posting a reply; a non-suspended buyer still succeeds (control)', async () => {
      const { eventId } = await seedPublishedEvent();
      await seedBuyer();
      const created = await request(app)
        .post(`/api/community/${eventId}/questions`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .send({ body: 'Question body' })
        .expect(201);
      const questionId = created.body.data.id;

      await seedSuspendedBuyer(SUSPENDED_PHONE, 'Suspended Replier');
      await seedBuyer(OK_PHONE, 'OK Replier');

      await request(app)
        .post(`/api/community/questions/${questionId}/replies`)
        .set('Authorization', `Bearer ${signBuyerToken(SUSPENDED_PHONE)}`)
        .send({ body: 'A reply' })
        .expect(403);

      await request(app)
        .post(`/api/community/questions/${questionId}/replies`)
        .set('Authorization', `Bearer ${signBuyerToken(OK_PHONE)}`)
        .send({ body: 'A reply' })
        .expect(201);
    });

    it('403s a suspended buyer liking a question; a non-suspended buyer still succeeds (control)', async () => {
      const { eventId } = await seedPublishedEvent();
      await seedBuyer();
      const created = await request(app)
        .post(`/api/community/${eventId}/questions`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .send({ body: 'Question body' })
        .expect(201);
      const questionId = created.body.data.id;

      await seedSuspendedBuyer(SUSPENDED_PHONE, 'Suspended Liker');
      await seedBuyer(OK_PHONE, 'OK Liker');

      await request(app)
        .post(`/api/community/questions/${questionId}/like`)
        .set('Authorization', `Bearer ${signBuyerToken(SUSPENDED_PHONE)}`)
        .expect(403);

      await request(app)
        .post(`/api/community/questions/${questionId}/like`)
        .set('Authorization', `Bearer ${signBuyerToken(OK_PHONE)}`)
        .expect(200);
    });
  });

  describe('over-length body — 400 not 500', () => {
    const TOO_LONG = 'a'.repeat(1001);

    it('400s an over-length question body', async () => {
      const { eventId } = await seedPublishedEvent();
      await seedBuyer();
      await request(app)
        .post(`/api/community/${eventId}/questions`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .send({ body: TOO_LONG })
        .expect(400);
    });

    it('400s an over-length reply body', async () => {
      const { eventId } = await seedPublishedEvent();
      await seedBuyer();
      const auth = `Bearer ${signBuyerToken(PHONE)}`;
      const created = await request(app)
        .post(`/api/community/${eventId}/questions`)
        .set('Authorization', auth)
        .send({ body: 'Question body' })
        .expect(201);

      await request(app)
        .post(`/api/community/questions/${created.body.data.id}/replies`)
        .set('Authorization', auth)
        .send({ body: TOO_LONG })
        .expect(400);
    });
  });
});
