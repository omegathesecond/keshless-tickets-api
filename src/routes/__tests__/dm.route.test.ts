import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Membership } from '@models/membership.model';
import { CommunityService } from '@services/community.service';
import { BlockService } from '@services/block.service';
import { DmThread } from '@models/dmThread.model';
import { resetBuckets } from '@utils/rateLimit.util';

const PHONE_A = '+26878422613';
const PHONE_B = '+26878000042';

async function seedWorld() {
  const a = await Buyer.create({ phone: PHONE_A, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Alpha', username: 'alpha_one' });
  const b = await Buyer.create({ phone: PHONE_B, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Beta', username: 'beta_two' });
  const seeded = await seedPublishedEvent();
  const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
  await Membership.create({ buyerId: a._id, communityId: community._id });
  await Membership.create({ buyerId: b._id, communityId: community._id });
  return { a, b, authA: `Bearer ${signBuyerToken(PHONE_A)}`, authB: `Bearer ${signBuyerToken(PHONE_B)}` };
}

async function openThread(auth: string, otherId: string): Promise<string> {
  const res = await request(app).post('/api/dm/threads').set('Authorization', auth)
    .send({ participantIds: [otherId] }).expect(201);
  return res.body.data.id;
}

describe('dm routes', () => {
  beforeAll(async () => {
    await connectTestDb();
    await DmThread.init(); // unique pairKey index must exist before dedupe races it
  });
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('open thread, exchange messages, unread counts, mark read', async () => {
    const { a, b, authA, authB } = await seedWorld();
    const threadId = await openThread(authA, String(b._id));

    await request(app).post(`/api/dm/threads/${threadId}/messages`).set('Authorization', authA)
      .send({ body: 'hey beta' }).expect(201);
    await request(app).post(`/api/dm/threads/${threadId}/messages`).set('Authorization', authA)
      .send({ body: 'you around?' }).expect(201);

    // B lists threads: sees A as participant, 2 unread (own messages never count)
    const listB = await request(app).get('/api/dm/threads').set('Authorization', authB).expect(200);
    expect(listB.body.data).toHaveLength(1);
    expect(listB.body.data[0].unreadCount).toBe(2);
    expect(listB.body.data[0].participants.map((p: any) => p.username)).toEqual(['alpha_one']);
    expect(JSON.stringify(listB.body.data)).not.toContain(PHONE_A);

    // A sees 0 unread (sender)
    const listA = await request(app).get('/api/dm/threads').set('Authorization', authA).expect(200);
    expect(listA.body.data[0].unreadCount).toBe(0);

    const msgs = await request(app).get(`/api/dm/threads/${threadId}/messages`).set('Authorization', authB).expect(200);
    expect(msgs.body.data.map((m: any) => m.body)).toEqual(['you around?', 'hey beta']); // newest first
    expect(msgs.body.data[0].dmThreadId).toBe(threadId);
    expect(msgs.body.data[0].channelId).toBeNull();

    await request(app).post(`/api/dm/threads/${threadId}/read`).set('Authorization', authB).expect(200);
    const after = await request(app).get('/api/dm/threads').set('Authorization', authB).expect(200);
    expect(after.body.data[0].unreadCount).toBe(0);
    void a;
  });

  it('privacy: a stranger CAN open a thread (no connection required); a block still refuses it and refuses sends after the fact', async () => {
    const { a, b, authA } = await seedWorld();
    const stranger = await Buyer.create({ phone: '+26878000099', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
    await request(app).post('/api/dm/threads').set('Authorization', `Bearer ${signBuyerToken('+26878000099')}`)
      .send({ participantIds: [String(a._id)] }).expect(201);

    await BlockService.block(a, String(stranger._id));
    await request(app).post('/api/dm/threads').set('Authorization', `Bearer ${signBuyerToken('+26878000099')}`)
      .send({ participantIds: [String(a._id)] }).expect(403);

    const threadId = await openThread(authA, String(b._id));
    await BlockService.block(b, String(a._id));
    await request(app).post(`/api/dm/threads/${threadId}/messages`).set('Authorization', authA)
      .send({ body: 'blocked now' }).expect(403);
  });

  it('non-participant gets 404 on messages/read; delete-own works and masks', async () => {
    const { b, authA, authB } = await seedWorld();
    const outsider = await Buyer.create({ phone: '+26878000098', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
    const authO = `Bearer ${signBuyerToken('+26878000098')}`;
    const threadId = await openThread(authA, String(b._id));

    await request(app).get(`/api/dm/threads/${threadId}/messages`).set('Authorization', authO).expect(404);
    await request(app).post(`/api/dm/threads/${threadId}/read`).set('Authorization', authO).expect(404);

    const sent = await request(app).post(`/api/dm/threads/${threadId}/messages`).set('Authorization', authA)
      .send({ body: 'regret' }).expect(201);
    await request(app).delete(`/api/dm/messages/${sent.body.data.id}`).set('Authorization', authB).expect(403);
    await request(app).delete(`/api/dm/messages/${sent.body.data.id}`).set('Authorization', authA).expect(200);

    const msgs = await request(app).get(`/api/dm/threads/${threadId}/messages`).set('Authorization', authB).expect(200);
    expect(msgs.body.data[0].deleted).toBe(true);
    expect(msgs.body.data[0].body).toBe('');
    void outsider;
  });

  it('validation: bad participantIds 400; malformed cursors 400; rate limit shared with channels', async () => {
    const { b, authA } = await seedWorld();
    await request(app).post('/api/dm/threads').set('Authorization', authA).send({ participantIds: [] }).expect(400);
    await request(app).post('/api/dm/threads').set('Authorization', authA).send({ participantIds: ['zzz'] }).expect(400);

    const threadId = await openThread(authA, String(b._id));
    await request(app).get(`/api/dm/threads/${threadId}/messages?limit=abc`).set('Authorization', authA).expect(400);
    await request(app).get(`/api/dm/threads/${threadId}/messages?before=nope`).set('Authorization', authA).expect(400);

    resetBuckets();
    for (let i = 0; i < 5; i++) {
      await request(app).post(`/api/dm/threads/${threadId}/messages`).set('Authorization', authA)
        .send({ body: `m${i}` }).expect(201);
    }
    await request(app).post(`/api/dm/threads/${threadId}/messages`).set('Authorization', authA)
      .send({ body: 'too fast' }).expect(429);
  });
});
