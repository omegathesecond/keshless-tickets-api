import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';
import {
  weekendRecapCandidates,
  rankWeekendRecapCandidates,
  buildWeekendRecapFeedSlides,
  listWeekendRecaps,
  pickWeekendRecapLabel,
  WEEKEND_RECAP_LABELS,
} from '@services/weekendRecap.service';

async function seedRecap(caption: string, opts: { createdAt?: Date; hashtags?: string[]; eventId?: mongoose.Types.ObjectId; hiddenFromDiscoverAt?: Date | null; likeCount?: number; viewCount?: number } = {}) {
  const doc = await Update.create({
    authorType: 'buyer',
    authorId: new mongoose.Types.ObjectId(),
    kind: 'image',
    category: 'weekend_recap',
    caption,
    hashtags: opts.hashtags ?? [],
    eventId: opts.eventId,
    media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    likeCount: opts.likeCount ?? 0,
    viewCount: opts.viewCount ?? 0,
    hiddenFromDiscoverAt: opts.hiddenFromDiscoverAt ?? null,
  });
  if (opts.createdAt) {
    await Update.updateOne({ _id: doc._id }, { $set: { createdAt: opts.createdAt } });
  }
  return doc;
}

async function seedGeneralPost(caption: string) {
  return Update.create({
    authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', category: 'general', caption,
    media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
  });
}

describe('weekendRecap.service', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('weekendRecapCandidates', () => {
    it('only returns visible weekend_recap posts, never general ones', async () => {
      await seedRecap('r1');
      await seedGeneralPost('g1');
      const docs = await weekendRecapCandidates(10, [], false);
      expect(docs).toHaveLength(1);
      expect(docs[0]?.caption).toBe('r1');
    });

    it('excludes ids already served this session', async () => {
      const r1 = await seedRecap('r1');
      await seedRecap('r2');
      const docs = await weekendRecapCandidates(10, [String(r1._id)], false);
      expect(docs.map((d) => d.caption)).toEqual(['r2']);
    });

    it('hides admin-moderated posts only when forYou is true', async () => {
      await seedRecap('hidden', { hiddenFromDiscoverAt: new Date() });
      const forYou = await weekendRecapCandidates(10, [], true);
      const following = await weekendRecapCandidates(10, [], false);
      expect(forYou).toHaveLength(0);
      expect(following).toHaveLength(1);
    });
  });

  describe('rankWeekendRecapCandidates', () => {
    it('boosts posts created inside the current Sun-Tue window ahead of older ones', () => {
      // A Monday "now" — Sun-Tue window spans the day before through the day after.
      const now = new Date('2026-09-14T12:00:00.000Z'); // Monday
      const inWindow = { _id: '1', createdAt: new Date('2026-09-13T08:00:00.000Z') } as any; // Sunday
      const outOfWindow = { _id: '2', createdAt: new Date('2026-09-05T08:00:00.000Z') } as any; // prior Saturday
      const ranked = rankWeekendRecapCandidates([outOfWindow, inWindow], 10, now);
      expect(ranked.map((d) => d._id)).toEqual(['1', '2']);
    });

    it('trims to the requested limit', () => {
      const now = new Date('2026-09-14T12:00:00.000Z');
      const docs = [1, 2, 3].map((n) => ({ _id: String(n), createdAt: now }) as any);
      expect(rankWeekendRecapCandidates(docs, 2, now)).toHaveLength(2);
    });
  });

  describe('buildWeekendRecapFeedSlides', () => {
    it('produces weekendRecap-typed slides with a stable label and seeAll flag', async () => {
      const doc = await seedRecap('r1');
      const slides = await buildWeekendRecapFeedSlides([doc], null);
      expect(slides).toHaveLength(1);
      expect(slides[0].type).toBe('weekendRecap');
      expect(slides[0].seeAll).toBe(true);
      expect(WEEKEND_RECAP_LABELS).toContain(slides[0].label);
      expect(slides[0].label).toBe(pickWeekendRecapLabel(String(doc._id)));
    });
  });

  describe('listWeekendRecaps', () => {
    it('filters to posts tagged with an event under the "events" filter', async () => {
      const eventId = new mongoose.Types.ObjectId();
      await seedRecap('with-event', { eventId });
      await seedRecap('without-event');
      const { docs } = await listWeekendRecaps({ page: 1, limit: 20, sort: 'latest', filter: 'events' });
      expect(docs).toHaveLength(1);
      expect(docs[0]?.caption).toBe('with-event');
    });

    it('filters by a hashtag-mapped content filter (e.g. "food")', async () => {
      await seedRecap('food-post', { hashtags: ['food'] });
      await seedRecap('other-post', { hashtags: ['travel'] });
      const { docs } = await listWeekendRecaps({ page: 1, limit: 20, sort: 'latest', filter: 'food' });
      expect(docs).toHaveLength(1);
      expect(docs[0]?.caption).toBe('food-post');
    });

    it('sorts by most_liked and most_viewed', async () => {
      await seedRecap('low', { likeCount: 1, viewCount: 5 });
      await seedRecap('high', { likeCount: 9, viewCount: 1 });
      const byLikes = await listWeekendRecaps({ page: 1, limit: 20, sort: 'most_liked' });
      expect(byLikes.docs.map((d) => d.caption)).toEqual(['high', 'low']);
      const byViews = await listWeekendRecaps({ page: 1, limit: 20, sort: 'most_viewed' });
      expect(byViews.docs.map((d) => d.caption)).toEqual(['low', 'high']);
    });

    it('reports hasMore when a further page exists', async () => {
      for (let i = 0; i < 3; i++) await seedRecap('r' + i);
      const { docs, hasMore } = await listWeekendRecaps({ page: 1, limit: 2, sort: 'latest' });
      expect(docs).toHaveLength(2);
      expect(hasMore).toBe(true);
    });
  });
});
