import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Update } from '@models/update.model';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn().mockResolvedValue(undefined), reconcileStuckUpdates: jest.fn() }));

const PHONE = '+26878422613';

describe('POST /api/public/updates — What\'s Hot fields', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('creates a What\'s Hot post with venue/category/activityDate', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
    const res = await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({
        kind: 'image', caption: 'Big weekend party', items: [{ ext: 'jpg', contentType: 'image/jpeg' }],
        feature: 'whats-hot', hotCategory: 'Nightlife', venue: 'The Venue', activityDate: '2026-09-12T18:00:00.000Z',
      })
      .expect(201);
    const saved = await Update.findById(res.body.data.updateId);
    expect(saved?.feature).toBe('whats-hot');
    expect(saved?.hotCategory).toBe('Nightlife');
    expect(saved?.venue).toBe('The Venue');
    expect(saved?.activityDate?.toISOString()).toBe('2026-09-12T18:00:00.000Z');
  });

  it('rejects an invalid hotCategory', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
    await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'image', items: [{ ext: 'jpg', contentType: 'image/jpeg' }], feature: 'whats-hot', hotCategory: 'NotACategory' })
      .expect(400);
  });

  it('rejects an invalid feature value', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
    await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'image', items: [{ ext: 'jpg', contentType: 'image/jpeg' }], feature: 'trending' })
      .expect(400);
  });

  it('a plain post (no feature) never persists hotCategory/venue', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
    const res = await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'image', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
      .expect(201);
    const saved = await Update.findById(res.body.data.updateId);
    expect(saved?.feature ?? null).toBeNull();
  });
});

describe('PATCH /api/public/updates/:id', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lets the author edit a caption without touching the media', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await Update.create({
      authorType: 'buyer', authorId: author._id, kind: 'image', caption: 'old caption',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });
    const res = await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ caption: 'new caption' })
      .expect(200);
    expect(res.body.data.caption).toBe('new caption');
    const reloaded = await Update.findById(update.id);
    expect(reloaded?.caption).toBe('new caption');
    expect(reloaded?.media[0]?.status).toBe('ready');
  });

  it('lets the author edit a What\'s Hot venue/category after publishing', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await Update.create({
      authorType: 'buyer', authorId: author._id, kind: 'image', caption: 'x',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
      feature: 'whats-hot', hotCategory: 'Music', venue: 'Old Venue',
    });
    const res = await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ venue: 'New Venue', hotCategory: 'Food' })
      .expect(200);
    expect(res.body.data.venue).toBe('New Venue');
    expect(res.body.data.hotCategory).toBe('Food');
  });

  it('403s a non-author edit', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
    const OTHER_PHONE = '+26876000009';
    await Buyer.create({ phone: OTHER_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
    const update = await Update.create({
      authorType: 'buyer', authorId: author._id, kind: 'image', caption: 'x',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });
    await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(OTHER_PHONE)}`)
      .send({ caption: 'hijacked' })
      .expect(403);
  });
});

describe('GET /api/public/whats-hot', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedHot(caption: string, hotCategory: string) {
    const author = await Buyer.create({ phone: `+26876${Math.floor(Math.random() * 1e6)}`, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
    return Update.create({
      authorType: 'buyer', authorId: author._id, kind: 'image', caption,
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
      feature: 'whats-hot', hotCategory, activityDate: new Date(),
    });
  }

  it('lists eligible What\'s Hot posts, filterable by category', async () => {
    await seedHot('music post', 'Music');
    await seedHot('food post', 'Food');

    const res = await request(app).get('/api/public/whats-hot').expect(200);
    expect(res.body.data.items).toHaveLength(2);

    const filtered = await request(app).get('/api/public/whats-hot?category=Music').expect(200);
    expect(filtered.body.data.items).toHaveLength(1);
    expect(filtered.body.data.items[0].hotCategory).toBe('Music');
  });

  it('400s an invalid sort', async () => {
    await request(app).get('/api/public/whats-hot?sort=oldest').expect(400);
  });

  it('shows the empty-state-friendly shape when nothing qualifies', async () => {
    const res = await request(app).get('/api/public/whats-hot').expect(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.nextCursor).toBeNull();
  });
});
