import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';

const PHONE = '+26878422613';

async function seedBuyer(phone = PHONE, username = 'weekend_route_buyer') {
  return Buyer.create({ phone, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', username });
}

describe('Weekend routes', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('auth guards', () => {
    it('401s GET /me when signed out', async () => {
      await request(app).get('/api/social/weekend/me').expect(401);
    });

    it('401s PUT /me when signed out', async () => {
      await request(app).put('/api/social/weekend/me').send({ statusType: 'bored' }).expect(401);
    });

    it('401s DELETE /me when signed out', async () => {
      await request(app).delete('/api/social/weekend/me').expect(401);
    });

    it('401s POST /requests when signed out', async () => {
      await request(app)
        .post('/api/social/weekend/requests')
        .send({ recipientId: String(new mongoose.Types.ObjectId()), kind: 'request_to_meet' })
        .expect(401);
    });

    it('401s GET /requests when signed out', async () => {
      await request(app).get('/api/social/weekend/requests').expect(401);
    });

    it('401s POST /requests/:id/accept and /decline when signed out', async () => {
      const fakeId = String(new mongoose.Types.ObjectId());
      await request(app).post(`/api/social/weekend/requests/${fakeId}/accept`).expect(401);
      await request(app).post(`/api/social/weekend/requests/${fakeId}/decline`).expect(401);
    });

    it('401s DELETE /requests/:id when signed out', async () => {
      await request(app).delete(`/api/social/weekend/requests/${String(new mongoose.Types.ObjectId())}`).expect(401);
    });
  });

  describe('public routes work signed-out', () => {
    it('GET /feed returns 200 with no auth', async () => {
      const res = await request(app).get('/api/social/weekend/feed').expect(200);
      expect(res.body.data.cards).toEqual([]);
    });

    it('GET /feed/looking-for-plans returns 200 with no auth', async () => {
      const res = await request(app).get('/api/social/weekend/feed/looking-for-plans').expect(200);
      expect(res.body.data.cards).toEqual([]);
    });

    it('GET /users/:username returns 200 with no auth for an existing user with no status', async () => {
      const buyer = await seedBuyer();
      const res = await request(app).get(`/api/social/weekend/users/${buyer.username}`).expect(200);
      expect(res.body.data).toEqual({ username: buyer.username, hasStatus: false, status: null });
    });

    it('GET /users/:username 404s for an unknown username, even signed out', async () => {
      await request(app).get('/api/social/weekend/users/no_such_user_at_all').expect(404);
    });
  });

  describe('authenticated round trip', () => {
    it('lets a signed-in buyer set, read back, and remove their own status', async () => {
      await seedBuyer();
      const auth = `Bearer ${signBuyerToken(PHONE)}`;

      const put = await request(app)
        .put('/api/social/weekend/me')
        .set('Authorization', auth)
        .send({ statusType: 'bored', audience: 'public' })
        .expect(200);
      expect(put.body.data.status.statusType).toBe('bored');

      const get = await request(app).get('/api/social/weekend/me').set('Authorization', auth).expect(200);
      expect(get.body.data.status.statusType).toBe('bored');

      await request(app).delete('/api/social/weekend/me').set('Authorization', auth).expect(200);
      const after = await request(app).get('/api/social/weekend/me').set('Authorization', auth).expect(200);
      expect(after.body.data.status).toBeNull();
    });
  });
});
