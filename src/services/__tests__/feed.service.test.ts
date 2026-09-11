import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { getFeed } from '@services/feed.service';
import { Update } from '@models/update.model';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { EventPlan } from '@models/eventPlan.model';
import { EventPlanMember } from '@models/eventPlanMember.model';
import { EventStatus } from '@interfaces/event.interface';
import mongoose from 'mongoose';

async function seedReadyUpdate(caption: string) {
  return Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image', caption, media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }] });
}
async function seedEvent(name: string, status: EventStatus = EventStatus.PUBLISHED) {
  const vendor = await Vendor.create({ businessName: 'Org ' + name, password: 'password123', slug: 'org-' + name.toLowerCase() });
  return Event.create({
    vendorId: vendor._id, name, venue: 'V', eventDate: new Date(Date.now() + 86400000),
    startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
    status, ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
  });
}
describe('feed.service getFeed', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('returns a posts-only for-you feed — events are never blended into Discover', async () => {
    await seedReadyUpdate('u1'); await seedReadyUpdate('u2'); await seedReadyUpdate('u3');
    await seedEvent('E1');
    const { items } = await getFeed({ tab: 'for-you', limit: 8 });
    const types = items.map((i) => i.type);
    expect(types).toContain('update');
    // Discover is posts-only: the seeded event (and any synthetic activity
    // slide) must never appear in 'for-you'.
    expect(types.every((t) => t === 'update')).toBe(true);
    const updateSlide = items.find((i) => i.type === 'update');
    expect(updateSlide?.['viewCount']).toBe(0);
  });

  it('excludes non-ready updates from the feed', async () => {
    await Update.create({ authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'video', caption: 'processing', media: [{ rawKey: 'k', status: 'processing' }] });
    const { items } = await getFeed({ tab: 'for-you', limit: 8 });
    expect(items.find((i) => i.type === 'update')).toBeUndefined();
  });

  it('excludes admin-hidden posts from the for-you (Discover) feed', async () => {
    const visible = await seedReadyUpdate('visible');
    const hidden = await seedReadyUpdate('hidden');
    // $set the moderation stamp directly — mirrors what the admin hide endpoint
    // writes; the post stays 'active' and media-ready, only hiddenFromDiscoverAt
    // takes it off Discover.
    await Update.updateOne({ _id: hidden._id }, { $set: { hiddenFromDiscoverAt: new Date() } });

    const { items } = await getFeed({ tab: 'for-you', limit: 8 });
    const ids = items.map((i) => i.id);
    expect(ids).toContain(String(visible._id));
    expect(ids).not.toContain(String(hidden._id));
  });

  it('keeps admin-hidden posts in the following feed — hiding is Discover-only', async () => {
    const vendor = await Vendor.create({ businessName: 'Followed Org H', password: 'password123', slug: 'followed-org-h' });
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'password123' });
    const orgUpdate = await Update.create({
      authorType: 'vendor', authorId: vendor._id, kind: 'image', caption: 'hidden but followed',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
      hiddenFromDiscoverAt: new Date(),
    });
    await Follow.create({ followerId: buyer._id, targetType: 'organizer', targetId: vendor._id });

    const { items } = await getFeed({ tab: 'following', actor: { type: 'buyer', id: String(buyer._id) }, limit: 8 });
    expect(items.some((i) => i.id === String(orgUpdate._id))).toBe(true);
  });

  it('events tab returns only event slides', async () => {
    await seedReadyUpdate('u1'); await seedEvent('E1');
    const { items } = await getFeed({ tab: 'events', limit: 8 });
    expect(items.every((i) => i.type === 'event')).toBe(true);
  });

  it('paginates via nextCursor without repeating items', async () => {
    for (let i = 0; i < 10; i++) await seedReadyUpdate('u' + i);
    const p1 = await getFeed({ tab: 'for-you', limit: 4 });
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await getFeed({ tab: 'for-you', limit: 4, cursor: p1.nextCursor! });
    const p1ids = new Set(p1.items.map((i) => i.id));
    expect(p2.items.every((i) => !p1ids.has(i.id))).toBe(true);
  });

  it('paginates the events tab via the $skip-based event cursor without repeating items', async () => {
    for (let i = 0; i < 10; i++) await seedEvent('E' + i);
    const p1 = await getFeed({ tab: 'events', limit: 4 });
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await getFeed({ tab: 'events', limit: 4, cursor: p1.nextCursor! });
    const p1ids = new Set(p1.items.map((i) => i.id));
    expect(p2.items.every((i) => !p1ids.has(i.id))).toBe(true);
  });

  it('following tab includes updates authored by a followed organizer', async () => {
    const vendor = await Vendor.create({ businessName: 'Followed Org', password: 'password123', slug: 'followed-org' });
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'password123' });

    const orgUpdate = await Update.create({
      authorType: 'vendor', authorId: vendor._id, kind: 'image', caption: 'org update',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });

    // Without a follow, the following tab must NOT surface the organizer's update.
    const before = await getFeed({ tab: 'following', actor: { type: 'buyer', id: String(buyer._id) }, limit: 8 });
    expect(before.items.some((i) => i.id === String(orgUpdate._id))).toBe(false);

    await Follow.create({ followerId: buyer._id, targetType: 'organizer', targetId: vendor._id });

    const after = await getFeed({ tab: 'following', actor: { type: 'buyer', id: String(buyer._id) }, limit: 8 });
    const slide = after.items.find((i) => i.id === String(orgUpdate._id));
    expect(slide).toBeDefined();
    expect(slide!.type).toBe('update');
  });

  it('following tab includes an OLD post from a followed author alongside recent ones (diversify §3)', async () => {
    const vendor = await Vendor.create({ businessName: 'Old Content Org', password: 'password123', slug: 'old-content-org' });
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'password123' });
    await Follow.create({ followerId: buyer._id, targetType: 'organizer', targetId: vendor._id });

    const oldUpdate = await Update.create({
      authorType: 'vendor', authorId: vendor._id, kind: 'image', caption: 'old',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });
    await Update.updateOne({ _id: oldUpdate._id }, { $set: { createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 90) } });
    for (let i = 0; i < 5; i++) {
      await Update.create({
        authorType: 'vendor', authorId: vendor._id, kind: 'image', caption: 'recent' + i,
        media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
      });
    }

    // A random $sample draw can't be asserted deterministically to surface the
    // old post on any single call, so page through until the pool is
    // exhausted and confirm the old post was reachable at all — a plain
    // recency sort could NEVER have returned it while 5 newer posts exist.
    let cursor: string | undefined;
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      const page = await getFeed({ tab: 'following', actor: { type: 'buyer', id: String(buyer._id) }, limit: 2, cursor });
      if (page.items.some((it) => it.id === String(oldUpdate._id))) found = true;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(found).toBe(true);
  });

  it('following tab never repeats an update id across pages of the same random walk', async () => {
    const vendor = await Vendor.create({ businessName: 'Paging Org', password: 'password123', slug: 'paging-org' });
    const buyer = await Buyer.create({ phone: '+26878422613', password: 'password123' });
    await Follow.create({ followerId: buyer._id, targetType: 'organizer', targetId: vendor._id });
    for (let i = 0; i < 8; i++) {
      await Update.create({
        authorType: 'vendor', authorId: vendor._id, kind: 'image', caption: 'p' + i,
        media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
      });
    }

    const p1 = await getFeed({ tab: 'following', actor: { type: 'buyer', id: String(buyer._id) }, limit: 4 });
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await getFeed({ tab: 'following', actor: { type: 'buyer', id: String(buyer._id) }, limit: 4, cursor: p1.nextCursor! });
    const p1ids = new Set(p1.items.map((i) => i.id));
    expect(p2.items.every((i) => !p1ids.has(i.id))).toBe(true);
  });

  it('following tab scopes follow edges by the vendor actor\'s followerType', async () => {
    const viewerVendor = await Vendor.create({ businessName: 'Viewer Vendor', password: 'secret123', slug: 'viewer-vendor' });
    const followedOrg = await Vendor.create({ businessName: 'Followed Org For Vendor', password: 'secret123', slug: 'followed-org-for-vendor' });

    const orgUpdate = await Update.create({
      authorType: 'vendor', authorId: followedOrg._id, kind: 'image', caption: 'org update for vendor actor',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });

    // A buyer-typed edge that happens to reuse the viewer vendor's id value must NOT
    // leak into the vendor's following tab — the query must filter by followerType.
    await Follow.create({ followerType: 'buyer', followerId: viewerVendor._id, targetType: 'organizer', targetId: followedOrg._id });
    const withOnlyBuyerEdge = await getFeed({ tab: 'following', actor: { type: 'vendor', id: String(viewerVendor._id) }, limit: 8 });
    expect(withOnlyBuyerEdge.items.some((i) => i.id === String(orgUpdate._id))).toBe(false);

    await Follow.create({ followerType: 'vendor', followerId: viewerVendor._id, targetType: 'organizer', targetId: followedOrg._id });
    const withVendorEdge = await getFeed({ tab: 'following', actor: { type: 'vendor', id: String(viewerVendor._id) }, limit: 8 });
    const slide = withVendorEdge.items.find((i) => i.id === String(orgUpdate._id));
    expect(slide).toBeDefined();
    expect(slide!.type).toBe('update');
  });

  it('includes likeCount on event slides', async () => {
    await seedEvent('E-likes');
    const { items } = await getFeed({ tab: 'events', limit: 8 });
    const eventSlide = items.find((i) => i.type === 'event');
    expect(eventSlide?.['likeCount']).toBe(0);
  });

  // The deploy-window case, and the ONLY one that proves the `?? 0`: events
  // created before the counter existed have no likeCount path at all, and
  // .lean() does not apply schema defaults to an absent field. A freshly
  // created Event gets the default at insert, so $unset is what reproduces
  // the real shape of an old row.
  it('defaults likeCount to 0 for events predating the counter', async () => {
    const e = await seedEvent('E-old');
    await Event.updateOne({ _id: e._id }, { $unset: { likeCount: 1 } });

    const { items } = await getFeed({ tab: 'events', limit: 8 });
    const eventSlide = items.find((i) => i.type === 'event');
    expect(eventSlide?.['likeCount']).toBe(0);
  });

  // Discover feed event slides must expose ticketing/externalTicketUrl so the
  // frontend can tell an externally-sold event apart and NOT show a Carrot
  // buy affordance for it.
  it('exposes ticketing and externalTicketUrl on event slides for an external-ticketing event', async () => {
    const vendor = await Vendor.create({ businessName: 'Org External', password: 'password123', slug: 'org-external' });
    const event = await Event.create({
      vendorId: vendor._id, name: 'External Show', venue: 'V', eventDate: new Date(Date.now() + 86400000),
      startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000),
      status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
      ticketing: 'external', externalTicketUrl: 'https://tickets.example.com/buy',
    });

    const { items } = await getFeed({ tab: 'events', limit: 8 });
    const eventSlide = items.find((i) => i.id === String(event._id));
    expect(eventSlide?.['ticketing']).toBe('external');
    expect(eventSlide?.['externalTicketUrl']).toBe('https://tickets.example.com/buy');
  });

  it('defaults ticketing/externalTicketUrl to carrot/null for a carrot event slide', async () => {
    await seedEvent('E-carrot');
    const { items } = await getFeed({ tab: 'events', limit: 8 });
    const eventSlide = items.find((i) => i.type === 'event');
    expect(eventSlide?.['ticketing']).toBe('carrot');
    expect(eventSlide?.['externalTicketUrl']).toBeNull();
  });

  // Home feed follow-up: "do not use a fixed feed position for Vote cards" /
  // "vary their position whenever the feed is refreshed". A bare event (no
  // lineup/outfit) still gets the always-on attending_with/busy questions
  // (see vote.service.test.ts), so it's eligible for a Vote feed card the
  // moment it's published within the 7-day activation window.
  async function seedVoteEligibleEvent() {
    const now = Date.now();
    const startTime = new Date(now + 2 * 86400000);
    return Event.create({
      vendorId: new mongoose.Types.ObjectId(), name: 'Vote Event', venue: 'V',
      eventDate: startTime, startTime, endTime: new Date(startTime.getTime() + 3 * 3600000),
      status: EventStatus.PUBLISHED, publishedAt: new Date(now - 86400000),
      ticketTypes: [{ name: 'GA', price: 100, quantity: 50 }],
    });
  }

  it('varies the Vote card slot across fresh feed loads instead of a fixed position', async () => {
    for (let i = 0; i < 12; i++) await seedReadyUpdate('u' + i);
    await seedVoteEligibleEvent();

    const positions = new Set<number>();
    for (let i = 0; i < 25; i++) {
      const { items } = await getFeed({ tab: 'for-you', limit: 11 });
      const idx = items.findIndex((it) => it.type === 'vote');
      expect(idx).toBeGreaterThanOrEqual(0);
      positions.add(idx);
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it('never puts the Vote card in the very first slot of a fresh feed load', async () => {
    for (let i = 0; i < 12; i++) await seedReadyUpdate('u' + i);
    await seedVoteEligibleEvent();

    for (let i = 0; i < 15; i++) {
      const { items } = await getFeed({ tab: 'for-you', limit: 11 });
      expect(items[0]?.type).not.toBe('vote');
    }
  });

  // Home feed follow-up (ticket): "Public Plans can be discovered through
  // the Home feed" / "publish a plan ... after it is created" / "remove it
  // immediately if it is changed to Private or cancelled".
  describe('Event Plan cards (Home feed discoverability follow-up)', () => {
    async function seedPlan(overrides: Partial<any> = {}) {
      const suffix = new mongoose.Types.ObjectId().toString().slice(-8);
      const admin = await Buyer.create({ phone: '+26878400000' + Math.floor(Math.random() * 1000), password: 'password123', name: 'Plan Admin', username: 'plan_' + suffix });
      const event = await seedEvent('Plan Event ' + suffix);
      const plan = await EventPlan.create({
        eventId: event._id, adminId: admin._id, name: 'Pregame squad',
        description: 'Meet up before doors', visibility: 'public', joinPolicy: 'open', status: 'active',
        ...overrides,
      });
      await EventPlanMember.create({ planId: plan._id, buyerId: admin._id, role: 'admin', status: 'accepted', joinedAt: new Date() });
      return { plan, admin, event };
    }

    it('surfaces a public active plan as a plan-type feed slide', async () => {
      for (let i = 0; i < 20; i++) await seedReadyUpdate('u' + i);
      const { plan } = await seedPlan();

      let found: any = null;
      for (let i = 0; i < 20 && !found; i++) {
        const { items } = await getFeed({ tab: 'for-you', limit: 12 });
        found = items.find((it) => it.type === 'plan' && it.id === String(plan._id));
      }
      expect(found).toBeTruthy();
      expect(found.visibility).toBe('public');
      expect(found.name).toBe('Pregame squad');
      expect(found.admin?.name).toBe('Plan Admin');
      expect(found.event?.name).toContain('Plan Event');
      expect(found.memberCount).toBe(1);
    });

    it('never surfaces a private plan in the feed', async () => {
      for (let i = 0; i < 10; i++) await seedReadyUpdate('u' + i);
      const { plan } = await seedPlan({ visibility: 'private' });

      for (let i = 0; i < 10; i++) {
        const { items } = await getFeed({ tab: 'for-you', limit: 12 });
        expect(items.some((it) => it.type === 'plan' && it.id === String(plan._id))).toBe(false);
      }
    });

    it('never surfaces a cancelled plan in the feed', async () => {
      for (let i = 0; i < 10; i++) await seedReadyUpdate('u' + i);
      const { plan } = await seedPlan({ status: 'cancelled', cancelledAt: new Date() });

      for (let i = 0; i < 10; i++) {
        const { items } = await getFeed({ tab: 'for-you', limit: 12 });
        expect(items.some((it) => it.type === 'plan' && it.id === String(plan._id))).toBe(false);
      }
    });

    it('removes a plan from the feed immediately after it is switched to private (live query, no stale cache)', async () => {
      for (let i = 0; i < 15; i++) await seedReadyUpdate('u' + i);
      const { plan } = await seedPlan();

      let seenPublic = false;
      for (let i = 0; i < 15 && !seenPublic; i++) {
        const { items } = await getFeed({ tab: 'for-you', limit: 12 });
        if (items.some((it) => it.type === 'plan' && it.id === String(plan._id))) seenPublic = true;
      }
      expect(seenPublic).toBe(true);

      await EventPlan.updateOne({ _id: plan._id }, { $set: { visibility: 'private' } });

      for (let i = 0; i < 10; i++) {
        const { items } = await getFeed({ tab: 'for-you', limit: 12 });
        expect(items.some((it) => it.type === 'plan' && it.id === String(plan._id))).toBe(false);
      }
    });

    it('events tab never surfaces plan slides — dedicated event browsing only', async () => {
      await seedReadyUpdate('u1');
      await seedEvent('E-events-tab');
      await seedPlan();

      const { items } = await getFeed({ tab: 'events', limit: 12 });
      expect(items.every((i) => i.type === 'event')).toBe(true);
    });

    it('includes the small overlapping member-avatar sample and viewer membership status', async () => {
      for (let i = 0; i < 10; i++) await seedReadyUpdate('u' + i);
      const { plan, admin } = await seedPlan();
      const member = await Buyer.create({ phone: '+26878411111', password: 'password123', name: 'Joined Friend', username: 'joined_friend', avatarUrl: 'https://cdn.example.com/a.jpg' });
      await EventPlanMember.create({ planId: plan._id, buyerId: member._id, role: 'member', status: 'accepted', joinedAt: new Date() });

      let found: any = null;
      for (let i = 0; i < 20 && !found; i++) {
        const { items } = await getFeed({ tab: 'for-you', limit: 12, actor: { type: 'buyer', id: String(admin._id) } });
        found = items.find((it) => it.type === 'plan' && it.id === String(plan._id));
      }
      expect(found).toBeTruthy();
      expect(found.memberCount).toBe(2);
      expect(found.memberAvatars.length).toBe(2);
      expect(found.viewer.isAdmin).toBe(true);
      expect(found.viewer.memberStatus).toBe('accepted');
    });
  });
});
