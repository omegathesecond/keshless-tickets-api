import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Story } from '@models/story.model';
import { FollowService } from '@services/follow.service';
import { BlockService } from '@services/block.service';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn().mockResolvedValue(undefined), reconcileStuckUpdates: jest.fn() }));

const PHONE = '+26878422613';
const AUTHOR_PHONE = '+26878400101';

describe('Stories API', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  /** A ready-to-play image story by `authorId`, active for 24h. */
  const seedReadyStory = (authorId: string, overrides: Record<string, unknown> = {}) =>
    Story.create({
      authorType: 'buyer', authorId, kind: 'image',
      media: { rawKey: 'k', status: 'ready', image: { url: `https://cdn.carrottickets.com/${authorId}.jpg`, width: 1, height: 1 } },
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      ...overrides,
    });

  describe('POST /api/social/stories', () => {
    it('creates a processing story and returns a presigned upload url', async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
      const res = await request(app)
        .post('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' })
        .expect(201);

      expect(res.body.data.uploadUrl).toContain('https://r2.example/put');
      expect(res.body.data.storyId).toBeTruthy();
      const stored = await Story.findById(res.body.data.storyId);
      expect(stored?.media!.status).toBe('processing');
      expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('401s without a token', async () => {
      await request(app).post('/api/social/stories').send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' }).expect(401);
    });

    it('403s a suspended buyer creating a story; a non-suspended buyer still succeeds (control)', async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Suspended Poster', socialSuspendedAt: new Date() });
      await request(app)
        .post('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' })
        .expect(403);

      await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'OK Poster' });
      await request(app)
        .post('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(AUTHOR_PHONE)}`)
        .send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' })
        .expect(201);
    });
  });

  describe('POST /api/social/stories/:id/finalize', () => {
    it('marks an image story ready with a url', async () => {
      const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
      const create = await request(app)
        .post('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .send({ kind: 'image', ext: 'jpg', contentType: 'image/jpeg' })
        .expect(201);

      const res = await request(app)
        .post(`/api/social/stories/${create.body.data.storyId}/finalize`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);

      expect(res.body.data.media.status).toBe('ready');
      expect(res.body.data.media.image.url).toBe('https://cdn.carrottickets.com/updates/raw/1-abc.jpg');
      void buyer;
    });

    it("forbids finalizing someone else's story", async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
      const other = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Other' });
      const story = await Story.create({
        authorType: 'buyer', authorId: other._id, kind: 'image',
        media: { rawKey: 'k', status: 'processing' },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      await request(app)
        .post(`/api/social/stories/${story.id}/finalize`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(403);
    });

    it('401s without a token', async () => {
      await request(app).post('/api/social/stories/000000000000000000000000/finalize').expect(401);
    });
  });

  describe('GET /api/social/stories', () => {
    it("returns a followed author's ready active story grouped, seen:false, then seen:true after marking it seen", async () => {
      const viewer = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Viewer' });
      const author = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
      await FollowService.follow(viewer, 'buyer', String(author._id));
      const story = await seedReadyStory(String(author._id));

      const auth = `Bearer ${signBuyerToken(PHONE)}`;
      const first = await request(app).get('/api/social/stories').set('Authorization', auth).expect(200);
      expect(first.body.data.stories).toHaveLength(1);
      expect(first.body.data.stories[0].seen).toBe(false);
      expect(first.body.data.stories[0].author.id).toBe(String(author._id));

      await request(app).post(`/api/social/stories/${story.id}/seen`).set('Authorization', auth).expect(200);

      const second = await request(app).get('/api/social/stories').set('Authorization', auth).expect(200);
      expect(second.body.data.stories[0].seen).toBe(true);
    });

    it('excludes an EXPIRED story (expiresAt in the past)', async () => {
      const viewer = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Viewer' });
      const author = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await seedReadyStory(String(author._id), { expiresAt: new Date(Date.now() - 1000) });

      const res = await request(app)
        .get('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);
      expect(res.body.data.stories).toEqual([]);
    });

    it('includes a story from a non-followed author — Stories are visible to everyone', async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Viewer' });
      const stranger = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Stranger' });
      await seedReadyStory(String(stranger._id));

      const res = await request(app)
        .get('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);
      expect(res.body.data.stories).toHaveLength(1);
      expect(res.body.data.stories[0].author.id).toBe(String(stranger._id));
    });

    it('excludes a story from a blocked author', async () => {
      const viewer = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Viewer' });
      const blocked = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Blocked' });
      await seedReadyStory(String(blocked._id));
      await BlockService.block(viewer, String(blocked._id));

      const res = await request(app)
        .get('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);
      expect(res.body.data.stories).toEqual([]);
    });

    it('401s without a token', async () => {
      await request(app).get('/api/social/stories').expect(401);
    });

    // Regression: durationSec used to come back null for images (only the
    // video transcoder ever set one), and the client's Math.max(1, null)
    // collapsed that to a 1-second flash. It must always be a real number.
    it('gives an image story a real 5s playback duration, never null', async () => {
      const viewer = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Viewer' });
      const author = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await seedReadyStory(String(author._id));

      const res = await request(app)
        .get('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);
      expect(res.body.data.stories[0].items[0].durationSec).toBe(5);
    });

    it('clamps a long video story to 30s', async () => {
      const viewer = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Viewer' });
      const author = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await Story.create({
        authorType: 'buyer', authorId: String(author._id), kind: 'video',
        media: {
          rawKey: 'k', status: 'ready',
          video: { url: 'https://cdn.carrottickets.com/v.mp4', poster: 'https://cdn.carrottickets.com/p.jpg', width: 1, height: 1, durationSec: 120 },
        },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      const res = await request(app)
        .get('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);
      expect(res.body.data.stories[0].items[0].durationSec).toBe(30);
    });

    it('reports viewerCount on your OWN items but never on other authors\' items', async () => {
      const owner = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      const watcher = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Watcher' });
      const story = await seedReadyStory(String(owner._id));
      await FollowService.follow(watcher, 'buyer', String(owner._id));

      await request(app)
        .post(`/api/social/stories/${story.id}/seen`)
        .set('Authorization', `Bearer ${signBuyerToken(AUTHOR_PHONE)}`)
        .expect(200);

      const mine = await request(app)
        .get('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);
      expect(mine.body.data.stories[0].isOwn).toBe(true);
      expect(mine.body.data.stories[0].items[0].viewerCount).toBe(1);

      const theirs = await request(app)
        .get('/api/social/stories')
        .set('Authorization', `Bearer ${signBuyerToken(AUTHOR_PHONE)}`)
        .expect(200);
      expect(theirs.body.data.stories[0].isOwn).toBe(false);
      expect(theirs.body.data.stories[0].items[0].viewerCount).toBeUndefined();
    });
  });

  describe('POST /api/social/stories/:id/seen', () => {
    it('401s without a token', async () => {
      await request(app).post('/api/social/stories/000000000000000000000000/seen').expect(401);
    });

    // Previewing your own status is not a view: it must not add you to your
    // own viewer list, and must not dim your own ring (seen stays false).
    it('does NOT record the author viewing their own story', async () => {
      const owner = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      const story = await seedReadyStory(String(owner._id));
      const auth = `Bearer ${signBuyerToken(PHONE)}`;

      await request(app).post(`/api/social/stories/${story.id}/seen`).set('Authorization', auth).expect(200);

      const viewers = await request(app).get(`/api/social/stories/${story.id}/viewers`).set('Authorization', auth).expect(200);
      expect(viewers.body.data.count).toBe(0);

      const rail = await request(app).get('/api/social/stories').set('Authorization', auth).expect(200);
      expect(rail.body.data.stories[0].seen).toBe(false);
    });
  });

  describe('POST /api/social/stories/:id/like', () => {
    it('401s without a token', async () => {
      await request(app).post('/api/social/stories/000000000000000000000000/like').expect(401);
    });

    it('toggles the like on and back off, and it round-trips through the rail', async () => {
      const author = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Liker' });
      const story = await seedReadyStory(String(author._id));
      const auth = `Bearer ${signBuyerToken(PHONE)}`;

      const liked = await request(app).post(`/api/social/stories/${story.id}/like`).set('Authorization', auth).expect(200);
      expect(liked.body.data.liked).toBe(true);

      const afterLike = await request(app).get('/api/social/stories').set('Authorization', auth).expect(200);
      expect(afterLike.body.data.stories[0].items[0].viewerHasLiked).toBe(true);

      const unliked = await request(app).post(`/api/social/stories/${story.id}/like`).set('Authorization', auth).expect(200);
      expect(unliked.body.data.liked).toBe(false);

      const afterUnlike = await request(app).get('/api/social/stories').set('Authorization', auth).expect(200);
      expect(afterUnlike.body.data.stories[0].items[0].viewerHasLiked).toBe(false);
    });

    it('404s for a story that does not exist', async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Liker' });
      await request(app)
        .post('/api/social/stories/000000000000000000000000/like')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(404);
    });

    it('one tap creates only one like — round-tripped likeCount stays 1, never duplicates', async () => {
      const author = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Liker' });
      const story = await seedReadyStory(String(author._id));
      const likerAuth = `Bearer ${signBuyerToken(PHONE)}`;
      const authorAuth = `Bearer ${signBuyerToken(AUTHOR_PHONE)}`;

      await request(app).post(`/api/social/stories/${story.id}/like`).set('Authorization', likerAuth).expect(200);

      const asAuthor = await request(app).get('/api/social/stories').set('Authorization', authorAuth).expect(200);
      expect(asAuthor.body.data.stories[0].items[0].likeCount).toBe(1);

      const likers = await request(app).get(`/api/social/stories/${story.id}/likers`).set('Authorization', authorAuth).expect(200);
      expect(likers.body.data.count).toBe(1);
    });
  });

  describe('GET /api/social/stories/:id/likers', () => {
    it('lists who liked the story, newest first, for the author only', async () => {
      const owner = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      const first = await Buyer.create({ phone: '+26878400402', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'First Liker', username: 'firstl' });
      const second = await Buyer.create({ phone: '+26878400403', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Second Liker', username: 'secondl' });
      const story = await seedReadyStory(String(owner._id));

      await request(app).post(`/api/social/stories/${story.id}/like`).set('Authorization', `Bearer ${signBuyerToken('+26878400402')}`).expect(200);
      await request(app).post(`/api/social/stories/${story.id}/like`).set('Authorization', `Bearer ${signBuyerToken('+26878400403')}`).expect(200);

      const res = await request(app)
        .get(`/api/social/stories/${story.id}/likers`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);

      expect(res.body.data.count).toBe(2);
      expect(res.body.data.likers.map((v: any) => v.name)).toEqual(['Second Liker', 'First Liker']);
      expect(res.body.data.likers[0]).toMatchObject({ type: 'buyer', username: 'secondl', id: String(second._id) });
      expect(res.body.data.likers[0].likedAt).toBeTruthy();
      void first;
    });

    it("403s a non-author asking who liked someone else's story", async () => {
      const owner = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Nosy' });
      const story = await seedReadyStory(String(owner._id));

      await request(app)
        .get(`/api/social/stories/${story.id}/likers`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(403);
    });

    it('404s an unknown story id', async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      await request(app)
        .get('/api/social/stories/000000000000000000000000/likers')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(404);
    });

    it('401s without a token', async () => {
      await request(app).get('/api/social/stories/000000000000000000000000/likers').expect(401);
    });
  });

  describe('GET /api/social/stories/:id/viewers', () => {
    it('lists who saw the story, newest first, for the author', async () => {
      const owner = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      const first = await Buyer.create({ phone: '+26878400202', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'First Watcher', username: 'firstw' });
      const second = await Buyer.create({ phone: '+26878400303', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Second Watcher', username: 'secondw' });
      const story = await seedReadyStory(String(owner._id));
      await FollowService.follow(first, 'buyer', String(owner._id));
      await FollowService.follow(second, 'buyer', String(owner._id));

      await request(app).post(`/api/social/stories/${story.id}/seen`).set('Authorization', `Bearer ${signBuyerToken('+26878400202')}`).expect(200);
      await request(app).post(`/api/social/stories/${story.id}/seen`).set('Authorization', `Bearer ${signBuyerToken('+26878400303')}`).expect(200);

      const res = await request(app)
        .get(`/api/social/stories/${story.id}/viewers`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);

      expect(res.body.data.count).toBe(2);
      expect(res.body.data.viewers.map((v: any) => v.name)).toEqual(['Second Watcher', 'First Watcher']);
      expect(res.body.data.viewers[0]).toMatchObject({ type: 'buyer', username: 'secondw', id: String(second._id) });
      expect(res.body.data.viewers[0].seenAt).toBeTruthy();
    });

    it("403s a non-author asking who saw someone else's story", async () => {
      const owner = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Nosy' });
      const story = await seedReadyStory(String(owner._id));

      await request(app)
        .get(`/api/social/stories/${story.id}/viewers`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(403);
    });

    it('404s an unknown story id', async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      await request(app)
        .get('/api/social/stories/000000000000000000000000/viewers')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(404);
    });

    it('401s without a token', async () => {
      await request(app).get('/api/social/stories/000000000000000000000000/viewers').expect(401);
    });
  });

  describe('DELETE /api/social/stories/:id', () => {
    it('lets the author delete their own story', async () => {
      const owner = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      const story = await seedReadyStory(String(owner._id));

      await request(app)
        .delete(`/api/social/stories/${story.id}`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(200);

      expect(await Story.findById(story.id)).toBeNull();
    });

    it("403s deleting someone else's story", async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Nosy' });
      const owner = await Buyer.create({ phone: AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      const story = await seedReadyStory(String(owner._id));

      await request(app)
        .delete(`/api/social/stories/${story.id}`)
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(403);
      expect(await Story.findById(story.id)).not.toBeNull();
    });

    it('404s an unknown story id', async () => {
      await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Owner' });
      await request(app)
        .delete('/api/social/stories/000000000000000000000000')
        .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
        .expect(404);
    });

    it('401s without a token', async () => {
      await request(app).delete('/api/social/stories/000000000000000000000000').expect(401);
    });
  });
});
