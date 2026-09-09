import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventQuestion } from '@models/eventQuestion.model';

const PHONE = '+26878422613';

async function seedBuyer(phone = PHONE, name = 'Test Buyer') {
  return Buyer.create({ phone, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name });
}

describe('GET /api/public/questions', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns { questions: [] } when there are no questions across any event', async () => {
    const res = await request(app).get('/api/public/questions').expect(200);
    expect(res.body.data).toEqual({ questions: [] });
  });

  it('returns questions from 2 different events newest-first, each with event name + author + replies + viewerHasLiked', async () => {
    const eventA = await seedPublishedEvent();
    await Event.findByIdAndUpdate(eventA.eventId, { name: 'Summer Jam' });
    const eventB = await seedPublishedEvent();
    await Event.findByIdAndUpdate(eventB.eventId, { name: 'Winter Fest' });
    const buyer = await seedBuyer();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;

    const q1 = await request(app)
      .post(`/api/community/${eventA.eventId}/questions`)
      .set('Authorization', auth)
      .send({ body: 'Question on event A' })
      .expect(201);

    const q2 = await request(app)
      .post(`/api/community/${eventB.eventId}/questions`)
      .set('Authorization', auth)
      .send({ body: 'Question on event B' })
      .expect(201);

    await request(app)
      .post(`/api/community/questions/${q1.body.data.id}/replies`)
      .set('Authorization', auth)
      .send({ body: 'A reply on the first question' })
      .expect(201);

    const res = await request(app).get('/api/public/questions').set('Authorization', auth).expect(200);
    const { questions } = res.body.data;

    expect(questions.map((q: any) => q.id)).toEqual([q2.body.data.id, q1.body.data.id]);

    expect(questions[0].event).toEqual({ id: eventB.eventId, name: 'Winter Fest', image: null });
    expect(questions[0].author).toEqual(expect.objectContaining({ type: 'buyer', name: 'Test Buyer' }));
    expect(questions[0].viewerHasLiked).toBe(false);
    expect(questions[0].replies).toEqual([]);

    expect(questions[1].event).toEqual({ id: eventA.eventId, name: 'Summer Jam', image: null });
    expect(questions[1].replies).toHaveLength(1);
    expect(questions[1].replies[0].body).toBe('A reply on the first question');

    expect(await EventQuestion.countDocuments()).toBe(2);
  });

  it('defaults to 20 and does not go unbounded on a non-numeric limit query param', async () => {
    const { eventId } = await seedPublishedEvent();
    await seedBuyer();
    const auth = `Bearer ${signBuyerToken(PHONE)}`;
    for (let i = 0; i < 25; i++) {
      await request(app)
        .post(`/api/community/${eventId}/questions`)
        .set('Authorization', auth)
        .send({ body: `Question ${i}` })
        .expect(201);
    }

    const defaultRes = await request(app).get('/api/public/questions').expect(200);
    expect(defaultRes.body.data.questions).toHaveLength(20);

    const garbageLimitRes = await request(app).get('/api/public/questions?limit=not-a-number').expect(200);
    expect(garbageLimitRes.body.data.questions).toHaveLength(20);
  });

  it('works for an anonymous caller (no auth header), with viewerHasLiked false', async () => {
    const { eventId } = await seedPublishedEvent();
    await seedBuyer();
    await request(app)
      .post(`/api/community/${eventId}/questions`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ body: 'Anyone going?' })
      .expect(201);

    const res = await request(app).get('/api/public/questions').expect(200);
    expect(res.body.data.questions).toHaveLength(1);
    expect(res.body.data.questions[0].viewerHasLiked).toBe(false);
  });
});
