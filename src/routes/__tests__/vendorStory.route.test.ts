import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Story } from '@models/story.model';
import { FollowService } from '@services/follow.service';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn().mockResolvedValue(undefined), reconcileStuckUpdates: jest.fn() }));

const BUYER_PHONE = '+26878422613';

/**
 * Brand stories — the status rail on the organizer Home feed. The buyer twins
 * live in story.route.test.ts; these cover the /api/tickets/social mount, whose
 * actor is a Vendor rather than a Buyer.
 */
describe('Brand stories API (/api/tickets/social/stories)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  let vseq = 0;
  const makeVendor = (name?: string) => {
    vseq += 1;
    return Vendor.create({
      businessName: name ?? `Brand ${vseq}`,
      email: `vendor${vseq}-${Date.now()}@example.com`,
      phoneNumber: `+2687${8100000 + vseq}`,
      password: 'secret123',
    });
  };

  /** A ready-to-play image story by (authorType, authorId), active for 24h. */
  const seedReadyStory = (authorType: 'buyer' | 'vendor', authorId: string) =>
    Story.create({
      authorType, authorId, kind: 'image',
      media: { rawKey: 'k', status: 'ready', image: { url: `https://cdn.carrottickets.com/${authorId}.jpg`, width: 1, height: 1 } },
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });

  describe('POST /api/tickets/social/stories', () => {
    it('creates a processing story authored by the BRAND and returns a presigned upload url', async () => {
      const vendor = await makeVendor('Bhora Fest');
      const res = await request(app)
        .post('/api/tickets/social/stories')
        .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
        .send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' })
        .expect(201);

      expect(res.body.data.uploadUrl).toContain('https://r2.example/put');
      const stored = await Story.findById(res.body.data.storyId);
      expect(stored?.authorType).toBe('vendor');
      expect(String(stored?.authorId)).toBe(String(vendor._id));
      expect(stored?.media!.status).toBe('processing');
    });

    it('401s a buyer token (carries no vendorId)', async () => {
      await Buyer.create({ phone: BUYER_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Buyer' });
      await request(app)
        .post('/api/tickets/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
        .send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' })
        .expect(401);
    });

    it('401s without a token', async () => {
      await request(app).post('/api/tickets/social/stories').send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' }).expect(401);
    });

    it('400s an invalid contentType for the declared kind', async () => {
      const vendor = await makeVendor();
      await request(app)
        .post('/api/tickets/social/stories')
        .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
        .send({ kind: 'image', ext: 'mp4', contentType: 'video/mp4' })
        .expect(400);
    });
  });

  describe('POST /api/tickets/social/stories/:id/finalize', () => {
    it('finalizes an image story the brand authored', async () => {
      const vendor = await makeVendor();
      const token = `Bearer ${signVendorToken(String(vendor._id))}`;
      const create = await request(app)
        .post('/api/tickets/social/stories')
        .set('Authorization', token)
        .send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' })
        .expect(201);

      const res = await request(app)
        .post(`/api/tickets/social/stories/${create.body.data.storyId}/finalize`)
        .set('Authorization', token)
        .expect(200);
      expect(res.body.data.media.status).toBe('ready');
    });

    it("403s another brand's story", async () => {
      const author = await makeVendor('Author Brand');
      const stranger = await makeVendor('Nosy Brand');
      const story = await seedReadyStory('vendor', String(author._id));
      await request(app)
        .post(`/api/tickets/social/stories/${story.id}/finalize`)
        .set('Authorization', `Bearer ${signVendorToken(String(stranger._id))}`)
        .expect(403);
    });

    // The authorType half of the ownership check is load-bearing: a brand
    // whose _id happened to equal a buyer's must not be able to act on that
    // buyer's story just because the ids match.
    it("403s a buyer's story whose authorId collides with the brand's id", async () => {
      const vendor = await makeVendor();
      const story = await seedReadyStory('buyer', String(vendor._id));
      await request(app)
        .post(`/api/tickets/social/stories/${story.id}/finalize`)
        .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
        .expect(403);
    });
  });

  describe('GET /api/tickets/social/stories', () => {
    it("returns a followed buyer's story plus the brand's own, and flips seen after marking", async () => {
      const vendor = await makeVendor();
      const author = await Buyer.create({ phone: '+26878400301', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
      await FollowService.followAsVendor(String(vendor._id), 'buyer', String(author._id));
      const theirs = await seedReadyStory('buyer', String(author._id));
      await seedReadyStory('vendor', String(vendor._id));

      const token = `Bearer ${signVendorToken(String(vendor._id))}`;
      const first = await request(app).get('/api/tickets/social/stories').set('Authorization', token).expect(200);
      // Own group first, then the followed author's.
      expect(first.body.data.stories).toHaveLength(2);
      expect(first.body.data.stories[0].isOwn).toBe(true);
      expect(first.body.data.stories[0].author.type).toBe('organizer');
      expect(first.body.data.stories[0].author.id).toBe(String(vendor._id));
      const other = first.body.data.stories.find((g: any) => !g.isOwn);
      expect(other.author.id).toBe(String(author._id));
      expect(other.seen).toBe(false);

      await request(app).post(`/api/tickets/social/stories/${theirs.id}/seen`).set('Authorization', token).expect(200);

      const second = await request(app).get('/api/tickets/social/stories').set('Authorization', token).expect(200);
      expect(second.body.data.stories.find((g: any) => !g.isOwn).seen).toBe(true);
    });

    it('includes a story from an author the brand does not follow — Stories are visible to everyone', async () => {
      const vendor = await makeVendor();
      const stranger = await Buyer.create({ phone: '+26878400302', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Stranger' });
      await seedReadyStory('buyer', String(stranger._id));

      const res = await request(app)
        .get('/api/tickets/social/stories')
        .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
        .expect(200);
      expect(res.body.data.stories).toHaveLength(1);
      expect(res.body.data.stories[0].author.id).toBe(String(stranger._id));
    });

    it('401s a buyer token', async () => {
      await Buyer.create({ phone: BUYER_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Buyer' });
      await request(app)
        .get('/api/tickets/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
        .expect(401);
    });
  });

  describe('GET /api/tickets/social/stories/:id/viewers', () => {
    it("lists who saw the brand's own story, and 403s a story the brand did not author", async () => {
      const vendor = await makeVendor();
      const viewer = await Buyer.create({ phone: '+26878400303', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Watcher' });
      await FollowService.follow(viewer, 'organizer', String(vendor._id));
      const mine = await seedReadyStory('vendor', String(vendor._id));

      await request(app)
        .post(`/api/social/stories/${mine.id}/seen`)
        .set('Authorization', `Bearer ${signBuyerToken('+26878400303')}`)
        .expect(200);

      const res = await request(app)
        .get(`/api/tickets/social/stories/${mine.id}/viewers`)
        .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
        .expect(200);
      expect(res.body.data.count).toBe(1);
      expect(res.body.data.viewers[0].id).toBe(String(viewer._id));

      const otherBrand = await makeVendor('Nosy Brand');
      await request(app)
        .get(`/api/tickets/social/stories/${mine.id}/viewers`)
        .set('Authorization', `Bearer ${signVendorToken(String(otherBrand._id))}`)
        .expect(403);
    });
  });

  describe('GET /api/tickets/social/stories/:id/likers', () => {
    it("lists who liked the brand's own story, notifies the brand, and 403s a non-author brand", async () => {
      const vendor = await makeVendor();
      const liker = await Buyer.create({ phone: '+26878400404', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Liker', username: 'liker1' });
      const mine = await seedReadyStory('vendor', String(vendor._id));

      await request(app)
        .post(`/api/social/stories/${mine.id}/like`)
        .set('Authorization', `Bearer ${signBuyerToken('+26878400404')}`)
        .expect(200);

      const res = await request(app)
        .get(`/api/tickets/social/stories/${mine.id}/likers`)
        .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
        .expect(200);
      expect(res.body.data.count).toBe(1);
      expect(res.body.data.likers[0]).toMatchObject({ type: 'buyer', id: String(liker._id), username: 'liker1' });

      const asVendor = await request(app)
        .get('/api/tickets/social/stories')
        .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
        .expect(200);
      expect(asVendor.body.data.stories[0].items[0].likeCount).toBe(1);

      const otherBrand = await makeVendor('Nosy Brand');
      await request(app)
        .get(`/api/tickets/social/stories/${mine.id}/likers`)
        .set('Authorization', `Bearer ${signVendorToken(String(otherBrand._id))}`)
        .expect(403);
    });
  });

  describe('DELETE /api/tickets/social/stories/:id', () => {
    it('lets the brand delete its own story', async () => {
      const vendor = await makeVendor();
      const story = await seedReadyStory('vendor', String(vendor._id));

      await request(app)
        .delete(`/api/tickets/social/stories/${story.id}`)
        .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`)
        .expect(200);

      expect(await Story.findById(story.id)).toBeNull();
    });

    it("403s another brand's story", async () => {
      const author = await makeVendor('Author Brand');
      const stranger = await makeVendor('Nosy Brand');
      const story = await seedReadyStory('vendor', String(author._id));

      await request(app)
        .delete(`/api/tickets/social/stories/${story.id}`)
        .set('Authorization', `Bearer ${signVendorToken(String(stranger._id))}`)
        .expect(403);
      expect(await Story.findById(story.id)).not.toBeNull();
    });

    it('401s a buyer token', async () => {
      await Buyer.create({ phone: BUYER_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Buyer' });
      await request(app)
        .delete('/api/tickets/social/stories/000000000000000000000000')
        .set('Authorization', `Bearer ${signBuyerToken(BUYER_PHONE)}`)
        .expect(401);
    });
  });
});
