import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';
import { Buyer } from '@models/buyer.model';
import { computeLabel, isEligible, getFeedSlide, getSeeAll } from '@services/whatsHot.service';

let phoneCounter = 0;
async function seedBuyer() {
  phoneCounter += 1;
  return Buyer.create({ phone: `+2687841${String(1000 + phoneCounter)}`, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
}

async function seedHotUpdate(overrides: Partial<{ activityDate: Date | null; likeCount: number; commentCount: number; viewCount: number; hotCategory: string; createdAt: Date; caption: string }> = {}) {
  const authorId = (await seedBuyer())._id;
  return Update.create({
    authorType: 'buyer',
    authorId,
    kind: 'image',
    caption: overrides.caption ?? 'hot content',
    media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    feature: 'whats-hot',
    hotCategory: overrides.hotCategory ?? null,
    activityDate: overrides.activityDate ?? null,
    likeCount: overrides.likeCount ?? 0,
    commentCount: overrides.commentCount ?? 0,
    viewCount: overrides.viewCount ?? 0,
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  });
}

describe('whatsHot.service', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('computeLabel', () => {
    const now = new Date('2026-09-10T12:00:00.000Z'); // a Thursday

    it('labels a post whose activity date is today/past as "This Weekend"', () => {
      expect(computeLabel({ activityDate: now, likeCount: 0, commentCount: 0, viewCount: 0 } as any, now)).toBe('This Weekend');
    });

    it('labels a post one day out as "Starts Tomorrow"', () => {
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      expect(computeLabel({ activityDate: tomorrow, likeCount: 0, commentCount: 0, viewCount: 0 } as any, now)).toBe('Starts Tomorrow');
    });

    it('labels a post several days out as "Weekend Loading"', () => {
      const future = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      expect(computeLabel({ activityDate: future, likeCount: 0, commentCount: 0, viewCount: 0 } as any, now)).toBe('Weekend Loading');
    });

    it('labels a dateless, low-engagement post as "This Weekend"', () => {
      expect(computeLabel({ activityDate: null, likeCount: 1, commentCount: 0, viewCount: 2 } as any, now)).toBe('This Weekend');
    });

    it('labels a dateless, high-engagement post as "Don\'t Miss This"', () => {
      expect(computeLabel({ activityDate: null, likeCount: 15, commentCount: 10, viewCount: 50 } as any, now)).toBe("Don't Miss This");
    });
  });

  describe('isEligible', () => {
    it('is eligible while the anchored weekend has not ended', () => {
      const now = new Date('2026-09-11T12:00:00.000Z'); // Friday, mid-weekend
      expect(isEligible({ activityDate: now, createdAt: now } as any, now)).toBe(true);
    });

    it('is not eligible once the anchored weekend has ended', () => {
      const createdAt = new Date('2026-08-28T12:00:00.000Z'); // an older Friday
      const now = new Date('2026-09-10T12:00:00.000Z'); // two weekends later
      expect(isEligible({ activityDate: null, createdAt } as any, now)).toBe(false);
    });

    it('falls back to createdAt when there is no activityDate', () => {
      const now = new Date('2026-09-11T12:00:00.000Z');
      expect(isEligible({ activityDate: null, createdAt: now } as any, now)).toBe(true);
    });
  });

  describe('getFeedSlide', () => {
    it('returns null when nothing qualifies', async () => {
      expect(await getFeedSlide([])).toBeNull();
    });

    it('excludes ids already served this session', async () => {
      const now = new Date();
      const a = await seedHotUpdate({ activityDate: now });
      const b = await seedHotUpdate({ activityDate: now });
      const slide = await getFeedSlide([String(a._id)], 8, now);
      expect(slide).not.toBeNull();
      const ids = slide!.items.map((i) => i.id);
      expect(ids).toContain(String(b._id));
      expect(ids).not.toContain(String(a._id));
    });

    it('excludes expired What\'s Hot posts', async () => {
      const now = new Date('2026-09-10T12:00:00.000Z');
      const oldCreatedAt = new Date('2026-08-20T12:00:00.000Z');
      await seedHotUpdate({ activityDate: null, createdAt: oldCreatedAt });
      const slide = await getFeedSlide([], 8, now);
      expect(slide).toBeNull();
    });

    it('never surfaces a plain (non-whats-hot) post', async () => {
      const author = (await seedBuyer())._id;
      await Update.create({
        authorType: 'buyer', authorId: author, kind: 'image', caption: 'plain post',
        media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
      });
      expect(await getFeedSlide([])).toBeNull();
    });
  });

  describe('getSeeAll', () => {
    it('filters by category', async () => {
      const now = new Date();
      await seedHotUpdate({ activityDate: now, hotCategory: 'Music' });
      await seedHotUpdate({ activityDate: now, hotCategory: 'Food' });
      const { items } = await getSeeAll({ category: 'Music' });
      expect(items).toHaveLength(1);
      expect(items[0]!.hotCategory).toBe('Music');
    });

    it('sorts by most-liked', async () => {
      const now = new Date();
      const low = await seedHotUpdate({ activityDate: now, likeCount: 1 });
      const high = await seedHotUpdate({ activityDate: now, likeCount: 50 });
      const { items } = await getSeeAll({ sort: 'most-liked' });
      expect(items.map((i) => i.id)).toEqual([String(high._id), String(low._id)]);
    });

    it('paginates via nextCursor', async () => {
      const now = new Date();
      for (let i = 0; i < 3; i++) await seedHotUpdate({ activityDate: now });
      const page1 = await getSeeAll({ sort: 'latest', limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeTruthy();
      const page2 = await getSeeAll({ sort: 'latest', limit: 2, cursor: page1.nextCursor! });
      expect(page2.items).toHaveLength(1);
      const allIds = new Set([...page1.items, ...page2.items].map((i) => i.id));
      expect(allIds.size).toBe(3);
    });
  });
});
