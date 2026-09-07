import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { createStory, deleteStory, finalizeStory, listForViewer, listLikers, markSeen, toggleLike } from '@services/story.service';
import { Story } from '@models/story.model';
import { StorySeen } from '@models/storySeen.model';
import { Notification } from '@models/notification.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { FollowService } from '@services/follow.service';
import { BlockService } from '@services/block.service';
import { HttpError } from '@utils/httpError.util';
import { totalStoryPoints, STORY_POINTS } from '@services/storyPoints.service';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
const mockTriggerTranscode = jest.fn().mockResolvedValue(undefined);
jest.mock('@services/transcode.client', () => ({ triggerTranscode: (...a: any[]) => mockTriggerTranscode(...a) }));
jest.mock('@services/push.service', () => ({
  PushService: { sendToBuyer: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@utils/buyerOnline.util', () => ({
  isBuyerOnline: jest.fn().mockResolvedValue(false),
}));

describe('story.service', () => {
  beforeAll(connectTestDb);
  afterEach(async () => { await clearTestDb(); mockTriggerTranscode.mockClear(); });
  afterAll(disconnectTestDb);

  const buyerId = () => new mongoose.Types.ObjectId().toString();

  describe('createStory / finalizeStory', () => {
    it('createStory persists a processing story with a 48h expiry and returns a presigned URL', async () => {
      const before = Date.now();
      const { story, uploadUrl } = await createStory({
        actor: { type: 'buyer', id: buyerId() }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg',
      });
      expect(uploadUrl).toContain('https://r2.example/put');
      expect(story.media.status).toBe('processing');
      expect(story.media.rawKey).toBe('updates/raw/1-abc.jpg');
      const expiresInMs = story.expiresAt.getTime() - before;
      expect(expiresInMs).toBeGreaterThan(47.9 * 3600 * 1000);
      expect(expiresInMs).toBeLessThan(48.1 * 3600 * 1000);
    });

    it('finalizeStory(image) marks ready immediately with an image url', async () => {
      const { story } = await createStory({ actor: { type: 'buyer', id: buyerId() }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg' });
      const out = await finalizeStory(story.id);
      expect(out.media.status).toBe('ready');
      expect(out.media.image?.url).toBe('https://cdn.carrottickets.com/updates/raw/1-abc.jpg');
      expect(mockTriggerTranscode).not.toHaveBeenCalled();
    });

    it('finalizeStory(video) sets processingStartedAt and triggers transcode', async () => {
      const { story } = await createStory({ actor: { type: 'buyer', id: buyerId() }, kind: 'video', ext: 'mp4', contentType: 'video/mp4' });
      const out = await finalizeStory(story.id);
      expect(out.media.status).toBe('processing');
      expect(out.media.processingStartedAt).toBeInstanceOf(Date);
      expect(mockTriggerTranscode).toHaveBeenCalledTimes(1);
      // Regression: a video Story MUST tell the transcoder to write its result
      // back to the `stories` collection, not the default `updates` one — see
      // transcode.client#Transcodable and the CAVEAT this used to carry.
      expect(mockTriggerTranscode).toHaveBeenCalledWith(expect.objectContaining({ id: story.id, collection: 'stories' }));
    });

    it('finalizeStory throws 404 for an unknown id', async () => {
      await expect(finalizeStory(new mongoose.Types.ObjectId().toString())).rejects.toMatchObject({ statusCode: 404 });
    });

    it('finalizeStory(image) awards story points to a buyer author', async () => {
      const author = buyerId();
      const { story } = await createStory({ actor: { type: 'buyer', id: author }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg' });
      await finalizeStory(story.id);
      expect(await totalStoryPoints(author)).toBe(STORY_POINTS);
    });

    it('finalizeStory(image) never awards points to a vendor/organizer author', async () => {
      const author = buyerId();
      const { story } = await createStory({ actor: { type: 'vendor', id: author }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg' });
      await finalizeStory(story.id);
      expect(await totalStoryPoints(author)).toBe(0);
    });

    it('finalizeStory(video) does not award points — media never reaches ready here', async () => {
      const author = buyerId();
      const { story } = await createStory({ actor: { type: 'buyer', id: author }, kind: 'video', ext: 'mp4', contentType: 'video/mp4' });
      await finalizeStory(story.id);
      expect(await totalStoryPoints(author)).toBe(0);
    });

    it('finalizeStory(image) is idempotent for points even if called twice', async () => {
      const author = buyerId();
      const { story } = await createStory({ actor: { type: 'buyer', id: author }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg' });
      await finalizeStory(story.id);
      await finalizeStory(story.id);
      expect(await totalStoryPoints(author)).toBe(STORY_POINTS);
    });
  });

  describe('deleteStory', () => {
    it('the author can delete their own story, and its StorySeen rows go with it', async () => {
      const author = buyerId();
      const { story } = await createStory({ actor: { type: 'buyer', id: author }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg' });
      const viewer = { type: 'buyer' as const, id: buyerId() };
      await markSeen(story.id, viewer);

      await deleteStory(story.id, { type: 'buyer', id: author });

      expect(await Story.findById(story.id)).toBeNull();
      expect(await StorySeen.find({ storyId: story.id })).toHaveLength(0);
    });

    it('throws 403 for a non-author trying to delete someone else\'s story', async () => {
      const { story } = await createStory({ actor: { type: 'buyer', id: buyerId() }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg' });
      await expect(deleteStory(story.id, { type: 'buyer', id: buyerId() })).rejects.toMatchObject({ statusCode: 403 });
      expect(await Story.findById(story.id)).not.toBeNull();
    });

    it('throws 404 for an unknown story id', async () => {
      await expect(deleteStory(new mongoose.Types.ObjectId().toString(), { type: 'buyer', id: buyerId() })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('markSeen', () => {
    it('is idempotent — calling twice creates only one StorySeen row', async () => {
      const { story } = await createStory({ actor: { type: 'buyer', id: buyerId() }, kind: 'image', ext: 'jpg', contentType: 'image/jpeg' });
      const viewer = { type: 'buyer' as const, id: buyerId() };
      await markSeen(story.id, viewer);
      await markSeen(story.id, viewer);
      const rows = await StorySeen.find({ storyId: story.id, buyerId: viewer.id });
      expect(rows).toHaveLength(1);
    });

    it('throws 404 for an unknown story id', async () => {
      await expect(markSeen(new mongoose.Types.ObjectId().toString(), { type: 'buyer', id: buyerId() })).rejects.toBeInstanceOf(HttpError);
    });
  });

  describe('listForViewer', () => {
    const seedBuyer = (phone: string, extra: Record<string, unknown> = {}) => Buyer.create({ phone, password: 'secret1', ...extra });
    const seedReadyStory = (authorType: 'buyer' | 'vendor', authorId: string, overrides: Record<string, unknown> = {}) =>
      Story.create({
        authorType, authorId, kind: 'image',
        media: { rawKey: 'k', status: 'ready', image: { url: `https://cdn.carrottickets.com/${authorId}.jpg`, width: 1, height: 1 } },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
        ...overrides,
      });

    it('includes the viewer\'s own story, marked isOwn, even when nobody follows them', async () => {
      const viewer = await seedBuyer('+26878400001');
      await seedReadyStory('buyer', String(viewer._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(1);
      expect(groups[0]!.isOwn).toBe(true);
      expect(groups[0]!.author.id).toBe(String(viewer._id));
    });

    it('includes a followed buyer\'s ready story, grouped, seen:false', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400002');
      const author = await seedBuyer('+26878400003', { name: 'Author Buyer' });
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await seedReadyStory('buyer', String(author._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(1);
      const g = groups[0]!;
      expect(g.isOwn).toBe(false);
      expect(g.seen).toBe(false);
      expect(g.author).toEqual({ type: 'buyer', id: String(author._id), name: 'Author Buyer', username: null, avatarUrl: null });
      expect(g.items).toHaveLength(1);
      expect(g.items[0]!.mediaUrl).toContain('.jpg');
    });

    it('carries the author\'s username so the client can link to their profile', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400103');
      const author = await seedBuyer('+26878400104', { name: 'Author Buyer', username: 'authorbuyer' });
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await seedReadyStory('buyer', String(author._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups[0]!.author.username).toBe('authorbuyer');
    });

    it('includes a followed organizer (vendor) story, author.type=organizer', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400004');
      const vendor = await Vendor.create({ businessName: 'Acme Events', email: 'acme@x.co', password: 'secret1' });
      await FollowService.follow(viewer, 'organizer', String(vendor._id));
      await seedReadyStory('vendor', String(vendor._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(1);
      expect(groups[0]!.author).toEqual({ type: 'organizer', id: String(vendor._id), name: 'Acme Events', username: null, avatarUrl: null });
    });

    it('includes a story from a NON-followed, non-blocked author — Stories are visible to everyone', async () => {
      const viewer = await seedBuyer('+26878400005');
      const stranger = await seedBuyer('+26878400006', { name: 'Stranger' });
      await seedReadyStory('buyer', String(stranger._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(1);
      expect(groups[0]!.isOwn).toBe(false);
      expect(groups[0]!.author.id).toBe(String(stranger._id));
    });

    it('excludes a story from an author the viewer has blocked', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400017');
      const blocked = await seedBuyer('+26878400018');
      await seedReadyStory('buyer', String(blocked._id));
      await BlockService.block(viewer, String(blocked._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(0);
    });

    it('excludes a story from an author who has blocked the viewer', async () => {
      const viewer = await seedBuyer('+26878400019');
      const blocker: IBuyer = await seedBuyer('+26878400020');
      await seedReadyStory('buyer', String(blocker._id));
      await BlockService.block(blocker, String(viewer._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(0);
    });

    it('excludes an EXPIRED story (expiresAt in the past)', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400007');
      const author = await seedBuyer('+26878400008');
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await seedReadyStory('buyer', String(author._id), { expiresAt: new Date(Date.now() - 1000) });

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(0);
    });

    it('excludes a still-processing (not-ready) story', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400009');
      const author = await seedBuyer('+26878400010');
      await FollowService.follow(viewer, 'buyer', String(author._id));
      await Story.create({
        authorType: 'buyer', authorId: author._id, kind: 'video',
        media: { rawKey: 'k', status: 'processing' },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(0);
    });

    it('still surfaces the VIEWER\'S OWN processing story, with mediaStatus so the client can show it as pending', async () => {
      const viewer = await seedBuyer('+26878400021');
      await Story.create({
        authorType: 'buyer', authorId: viewer._id, kind: 'video',
        media: { rawKey: 'k', status: 'processing' },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(1);
      expect(groups[0]!.isOwn).toBe(true);
      expect(groups[0]!.items[0]!.mediaStatus).toBe('processing');
      expect(groups[0]!.items[0]!.mediaUrl).toBe('');
    });

    it('still surfaces the VIEWER\'S OWN failed story, with mediaStatus so the client can show a failure state', async () => {
      const viewer = await seedBuyer('+26878400022');
      await Story.create({
        authorType: 'buyer', authorId: viewer._id, kind: 'video',
        media: { rawKey: 'k', status: 'failed', error: 'transcode timed out' },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(1);
      expect(groups[0]!.items[0]!.mediaStatus).toBe('failed');
    });

    it('a ready story reports mediaStatus:ready', async () => {
      const viewer = await seedBuyer('+26878400023');
      await seedReadyStory('buyer', String(viewer._id));

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups[0]!.items[0]!.mediaStatus).toBe('ready');
    });

    it('reflects seen:true after markSeen for every item in the group', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400011');
      const author = await seedBuyer('+26878400012');
      await FollowService.follow(viewer, 'buyer', String(author._id));
      const story = await seedReadyStory('buyer', String(author._id));

      await markSeen(story.id, { type: 'buyer', id: String(viewer._id) });
      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups[0]!.seen).toBe(true);
    });

    it('orders own first, then unseen, then fully-seen', async () => {
      const viewer: IBuyer = await seedBuyer('+26878400013');
      const seenAuthor = await seedBuyer('+26878400014');
      const unseenAuthor = await seedBuyer('+26878400015');
      await FollowService.follow(viewer, 'buyer', String(seenAuthor._id));
      await FollowService.follow(viewer, 'buyer', String(unseenAuthor._id));
      const seenStory = await seedReadyStory('buyer', String(seenAuthor._id));
      await seedReadyStory('buyer', String(unseenAuthor._id));
      await seedReadyStory('buyer', String(viewer._id)); // own
      await markSeen(seenStory.id, { type: 'buyer', id: String(viewer._id) });

      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toHaveLength(3);
      expect(groups[0]!.isOwn).toBe(true);
      expect(groups[1]!.author.id).toBe(String(unseenAuthor._id));
      expect(groups[1]!.seen).toBe(false);
      expect(groups[2]!.author.id).toBe(String(seenAuthor._id));
      expect(groups[2]!.seen).toBe(true);
    });

    it('returns an empty array with no fake data when nothing is active', async () => {
      const viewer = await seedBuyer('+26878400016');
      const groups = await listForViewer({ type: 'buyer', id: String(viewer._id) });
      expect(groups).toEqual([]);
    });

    it('carries likeCount on the viewer\'s own item, but not on someone else\'s', async () => {
      const author = await seedBuyer('+26878400021');
      const other = await seedBuyer('+26878400022');
      const liker = await seedBuyer('+26878400023');
      const ownStory = await seedReadyStory('buyer', String(author._id));
      const otherStory = await seedReadyStory('buyer', String(other._id));
      await toggleLike(ownStory.id, { type: 'buyer', id: String(liker._id) });

      const asAuthor = await listForViewer({ type: 'buyer', id: String(author._id) });
      expect(asAuthor[0]!.items[0]!.likeCount).toBe(1);

      const asStranger = await listForViewer({ type: 'buyer', id: String(other._id) });
      const strangerOwnItem = asStranger.find((g) => g.isOwn)!.items[0]!;
      expect(strangerOwnItem.likeCount).toBe(0);
      const foreignGroup = asStranger.find((g) => !g.isOwn)!;
      expect(foreignGroup.items[0]!.likeCount).toBeUndefined();
      void otherStory;
    });
  });

  describe('toggleLike', () => {
    const seedBuyer = (phone: string, extra: Record<string, unknown> = {}) => Buyer.create({ phone, password: 'secret1', ...extra });
    const seedReadyStory = (authorType: 'buyer' | 'vendor', authorId: string) =>
      Story.create({
        authorType, authorId, kind: 'image',
        media: { rawKey: 'k', status: 'ready', image: { url: 'https://cdn.carrottickets.com/x.jpg', width: 1, height: 1 } },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

    it('likes then unlikes, and a second like creates no duplicate row', async () => {
      const author = await seedBuyer('+26878400030');
      const liker = await seedBuyer('+26878400031');
      const story = await seedReadyStory('buyer', String(author._id));

      const first = await toggleLike(story.id, { type: 'buyer', id: String(liker._id) });
      expect(first.liked).toBe(true);
      const second = await toggleLike(story.id, { type: 'buyer', id: String(liker._id) });
      expect(second.liked).toBe(false);
      const third = await toggleLike(story.id, { type: 'buyer', id: String(liker._id) });
      expect(third.liked).toBe(true);

      const rows = await listLikers(story.id, { type: 'buyer', id: String(author._id) });
      expect(rows).toHaveLength(1);
    });

    it('notifies the buyer author with "[Username] liked your story." when someone else likes', async () => {
      const author = await seedBuyer('+26878400032');
      const liker = await seedBuyer('+26878400033', { name: 'Liker Name', username: 'likerhandle' });
      const story = await seedReadyStory('buyer', String(author._id));

      await toggleLike(story.id, { type: 'buyer', id: String(liker._id) });

      const rows = await Notification.find({ recipientType: 'buyer', recipientId: author._id, type: 'story_like' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe('likerhandle liked your story.');
      expect(rows[0]!.data.storyId).toBe(story.id);
      expect(rows[0]!.data.actorId).toBe(String(liker._id));
    });

    it('notifies a vendor author directly when a buyer likes their story', async () => {
      const vendor = await Vendor.create({ businessName: 'Acme Events', email: 'acme-like@x.co', password: 'secret1' });
      const liker = await seedBuyer('+26878400034');
      const story = await seedReadyStory('vendor', String(vendor._id));

      await toggleLike(story.id, { type: 'buyer', id: String(liker._id) });

      const rows = await Notification.find({ recipientType: 'vendor', recipientId: vendor._id, type: 'story_like' });
      expect(rows).toHaveLength(1);
    });

    it('never notifies the author for liking their OWN story', async () => {
      const author = await seedBuyer('+26878400035');
      const story = await seedReadyStory('buyer', String(author._id));

      await toggleLike(story.id, { type: 'buyer', id: String(author._id) });

      const rows = await Notification.find({ recipientType: 'buyer', recipientId: author._id, type: 'story_like' });
      expect(rows).toHaveLength(0);
    });

    it('does not notify again on unlike', async () => {
      const author = await seedBuyer('+26878400036');
      const liker = await seedBuyer('+26878400037');
      const story = await seedReadyStory('buyer', String(author._id));

      await toggleLike(story.id, { type: 'buyer', id: String(liker._id) }); // like
      await toggleLike(story.id, { type: 'buyer', id: String(liker._id) }); // unlike

      const rows = await Notification.find({ recipientType: 'buyer', recipientId: author._id, type: 'story_like' });
      expect(rows).toHaveLength(1);
    });

    it('throws 404 for an unknown story id', async () => {
      await expect(toggleLike(new mongoose.Types.ObjectId().toString(), { type: 'buyer', id: buyerId() })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('listLikers', () => {
    const seedBuyer = (phone: string, extra: Record<string, unknown> = {}) => Buyer.create({ phone, password: 'secret1', ...extra });
    const seedReadyStory = (authorType: 'buyer' | 'vendor', authorId: string) =>
      Story.create({
        authorType, authorId, kind: 'image',
        media: { rawKey: 'k', status: 'ready', image: { url: 'https://cdn.carrottickets.com/x.jpg', width: 1, height: 1 } },
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      });

    it('author-only: throws 403 for a non-author', async () => {
      const author = await seedBuyer('+26878400040');
      const stranger = await seedBuyer('+26878400041');
      const story = await seedReadyStory('buyer', String(author._id));
      await expect(listLikers(story.id, { type: 'buyer', id: String(stranger._id) })).rejects.toMatchObject({ statusCode: 403 });
    });

    it('throws 404 for an unknown story id', async () => {
      await expect(listLikers(new mongoose.Types.ObjectId().toString(), { type: 'buyer', id: buyerId() })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('lists each liker\'s profile picture, name and username, newest first', async () => {
      const author = await seedBuyer('+26878400042');
      const first = await seedBuyer('+26878400043', { name: 'First Liker', username: 'first_liker', avatarUrl: 'https://cdn.x/first.jpg' });
      const second = await seedBuyer('+26878400044', { name: 'Second Liker', username: 'second_liker' });
      const story = await seedReadyStory('buyer', String(author._id));

      await toggleLike(story.id, { type: 'buyer', id: String(first._id) });
      await toggleLike(story.id, { type: 'buyer', id: String(second._id) });

      const rows = await listLikers(story.id, { type: 'buyer', id: String(author._id) });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ type: 'buyer', id: String(second._id), name: 'Second Liker', username: 'second_liker' });
      expect(rows[1]).toMatchObject({ type: 'buyer', id: String(first._id), name: 'First Liker', username: 'first_liker', avatarUrl: 'https://cdn.x/first.jpg' });
    });

    it('drops a like when the liker unlikes', async () => {
      const author = await seedBuyer('+26878400045');
      const liker = await seedBuyer('+26878400046');
      const story = await seedReadyStory('buyer', String(author._id));

      await toggleLike(story.id, { type: 'buyer', id: String(liker._id) });
      await toggleLike(story.id, { type: 'buyer', id: String(liker._id) }); // unlike

      const rows = await listLikers(story.id, { type: 'buyer', id: String(author._id) });
      expect(rows).toHaveLength(0);
    });

    it('returns an empty array (not 403) for the author when nobody has liked yet', async () => {
      const author = await seedBuyer('+26878400047');
      const story = await seedReadyStory('buyer', String(author._id));
      const rows = await listLikers(story.id, { type: 'buyer', id: String(author._id) });
      expect(rows).toEqual([]);
    });
  });
});
