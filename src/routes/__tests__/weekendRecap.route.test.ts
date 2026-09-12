import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';

import { Buyer } from '@models/buyer.model';

async function seedRecap(caption: string) {
  const author = await Buyer.create({ phone: '+2687840' + Math.floor(Math.random() * 1000000), password: 'secret1', name: 'Recap Poster', username: 'recap_' + Math.random().toString(36).slice(2) });
  return Update.create({
    authorType: 'buyer', authorId: author._id, kind: 'image', category: 'weekend_recap', caption,
    media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
  });
}

describe('GET /api/public/weekend-recaps', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns only weekend_recap posts, each with a label, never general posts', async () => {
    await seedRecap('r1');
    await Update.create({
      authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', category: 'general', caption: 'g1',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });
    const res = await request(app).get('/api/public/weekend-recaps').expect(200);
    expect(res.body.data.posts).toHaveLength(1);
    expect(res.body.data.posts[0].caption).toBe('r1');
    expect(res.body.data.posts[0].label).toBeTruthy();
    // Each post spans a DIFFERENT author on this page (unlike the by-author
    // grid), so it must carry its own hydrated author for the card header —
    // regression coverage for a bug where this endpoint used
    // UpdateController.dto (no per-post author) instead of
    // UpdateService.buildUpdateSlides.
    expect(res.body.data.posts[0].author).toEqual(expect.objectContaining({ type: 'buyer', name: 'Recap Poster', username: expect.stringMatching(/^recap_/) }));
  });

  it('returns an empty list (not an error) when there are no recap posts', async () => {
    const res = await request(app).get('/api/public/weekend-recaps').expect(200);
    expect(res.body.data.posts).toEqual([]);
    expect(res.body.data.hasMore).toBe(false);
  });

  it('400s an invalid sort value', async () => {
    await request(app).get('/api/public/weekend-recaps?sort=not-a-sort').expect(400);
  });

  it('400s an invalid filter value', async () => {
    await request(app).get('/api/public/weekend-recaps?filter=not-a-filter').expect(400);
  });
});
