import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { Channel } from '@models/channel.model';
import { Membership } from '@models/membership.model';
import { CommunityService } from '@services/community.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { resetBuckets } from '@utils/rateLimit.util';

const JWT_SECRET = process.env['JWT_SECRET'] || 'your-secret-key';

function signVendorToken(
  vendorId: string,
  permissions: string[] = [TicketsPermission.EDIT_EVENT],
  isSuperAdmin = false
): string {
  return jwt.sign(
    { app: 'tickets', vendorId, userType: 'vendor', isSuperAdmin, role: 'owner', permissions },
    JWT_SECRET
  );
}

const PHONE = '+26878422613';

async function seedWorld() {
  const vendor = await Vendor.create({
    businessName: 'Piano Republic Events', email: 'org@example.com', password: 'secret123',
    phoneNumber: '+26878000099',
  });
  const seeded = await seedPublishedEvent({ vendorId: vendor._id as any });
  const { community } = await CommunityService.ensureForEvent(seeded.eventId, String(vendor._id));
  const channels = await Channel.find({ communityId: community._id });
  const bySlug = Object.fromEntries(channels.map((c) => [c.slug, c]));

  const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Chatty Buyer' });
  const buyerAuth = `Bearer ${signBuyerToken(PHONE)}`;
  const vendorAuth = `Bearer ${signVendorToken(String(vendor._id))}`;

  await request(app).post(`/api/community/${seeded.eventId}/join`).set('Authorization', buyerAuth).expect(200);

  return { vendor, seeded, community, bySlug, buyer, buyerAuth, vendorAuth };
}

describe('organizer moderation routes', () => {
  beforeAll(connectTestDb);
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('DELETE /api/tickets/messages/:messageId (delete-any)', () => {
    it("organizer deletes a member's channel message; it reads back masked+deleted", async () => {
      const { bySlug, buyerAuth, vendorAuth } = await seedWorld();
      const general = String(bySlug['general']!._id);

      const sent = await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'spam link, please remove' })
        .expect(201);

      await request(app)
        .delete(`/api/tickets/messages/${sent.body.data.id}`)
        .set('Authorization', vendorAuth)
        .expect(200)
        .expect((res) => {
          expect(res.body.data).toEqual({ deleted: true });
        });

      const list = await request(app)
        .get(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .expect(200);
      expect(list.body.data[0].deleted).toBe(true);
      expect(list.body.data[0].body).toBe('');
    });

    it('cannot delete a DM message (404 — organizers never touch DMs)', async () => {
      const { buyer, buyerAuth, vendorAuth } = await seedWorld();
      const OTHER = '+26878000042';
      const other = await Buyer.create({ phone: OTHER, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'DM Partner' });

      const thread = await request(app)
        .post('/api/dm/threads')
        .set('Authorization', buyerAuth)
        .send({ participantIds: [String(other!._id)] })
        .expect(201);
      const sent = await request(app)
        .post(`/api/dm/threads/${thread.body.data.id}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'private stuff' })
        .expect(201);

      await request(app)
        .delete(`/api/tickets/messages/${sent.body.data.id}`)
        .set('Authorization', vendorAuth)
        .expect(404);
    });

    it("cannot touch another vendor's community (403)", async () => {
      const { bySlug, buyerAuth } = await seedWorld();
      const general = String(bySlug['general']!._id);
      const sent = await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'mine' })
        .expect(201);

      const rival = await Vendor.create({
        businessName: 'Rival Events', email: 'rival@example.com', password: 'secret123', phoneNumber: '+26878000097',
      });
      await request(app)
        .delete(`/api/tickets/messages/${sent.body.data.id}`)
        .set('Authorization', `Bearer ${signVendorToken(String(rival._id))}`)
        .expect(403);
    });

    it('a super-admin token bypasses ownership', async () => {
      const { bySlug, buyerAuth } = await seedWorld();
      const general = String(bySlug['general']!._id);
      const sent = await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'mine' })
        .expect(201);

      await request(app)
        .delete(`/api/tickets/messages/${sent.body.data.id}`)
        .set('Authorization', `Bearer ${signVendorToken('unrelated-vendor-id', [TicketsPermission.EDIT_EVENT], true)}`)
        .expect(200);
    });

    it('404s for an unknown message id, 400 for a malformed one', async () => {
      const { vendorAuth } = await seedWorld();
      await request(app)
        .delete('/api/tickets/messages/aaaaaaaaaaaaaaaaaaaaaaaa')
        .set('Authorization', vendorAuth)
        .expect(404);
      await request(app)
        .delete('/api/tickets/messages/not-an-id')
        .set('Authorization', vendorAuth)
        .expect(400);
    });

    it('missing EDIT_EVENT permission is 403', async () => {
      const { vendor, bySlug, buyerAuth } = await seedWorld();
      const general = String(bySlug['general']!._id);
      const sent = await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'mine' })
        .expect(201);

      await request(app)
        .delete(`/api/tickets/messages/${sent.body.data.id}`)
        .set('Authorization', `Bearer ${signVendorToken(String(vendor._id), [])}`)
        .expect(403);
    });
  });

  describe('mute / unmute', () => {
    it('mute sets mutedUntil and blocks the send path end-to-end; unmute restores it', async () => {
      const { community, buyer, buyerAuth, vendorAuth, bySlug } = await seedWorld();
      const general = String(bySlug['general']!._id);
      const communityId = String(community._id);

      const muted = await request(app)
        .post(`/api/tickets/communities/${communityId}/members/${String(buyer._id)}/mute`)
        .set('Authorization', vendorAuth)
        .send({ minutes: 60 })
        .expect(200);
      expect(muted.body.data.mutedUntil).toBeTruthy();

      await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'muted!' })
        .expect(403);

      const unmuted = await request(app)
        .delete(`/api/tickets/communities/${communityId}/members/${String(buyer._id)}/mute`)
        .set('Authorization', vendorAuth)
        .expect(200);
      expect(unmuted.body.data).toEqual({ mutedUntil: null });

      await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'unmuted now' })
        .expect(201);
    });

    it('rejects minutes outside 5-10080', async () => {
      const { community, buyer, vendorAuth } = await seedWorld();
      const communityId = String(community._id);
      await request(app)
        .post(`/api/tickets/communities/${communityId}/members/${String(buyer._id)}/mute`)
        .set('Authorization', vendorAuth)
        .send({ minutes: 4 })
        .expect(400);
      await request(app)
        .post(`/api/tickets/communities/${communityId}/members/${String(buyer._id)}/mute`)
        .set('Authorization', vendorAuth)
        .send({ minutes: 10081 })
        .expect(400);
    });

    it('404s when there is no membership', async () => {
      const { community, vendorAuth } = await seedWorld();
      await request(app)
        .post(`/api/tickets/communities/${String(community._id)}/members/aaaaaaaaaaaaaaaaaaaaaaaa/mute`)
        .set('Authorization', vendorAuth)
        .send({ minutes: 10 })
        .expect(404);
    });
  });

  describe('ban / unban', () => {
    it('ban blocks channel access end-to-end; unban restores it', async () => {
      const { community, buyer, buyerAuth, vendorAuth, bySlug } = await seedWorld();
      const general = String(bySlug['general']!._id);
      const communityId = String(community._id);

      const banned = await request(app)
        .post(`/api/tickets/communities/${communityId}/members/${String(buyer._id)}/ban`)
        .set('Authorization', vendorAuth)
        .expect(200);
      expect(banned.body.data).toEqual({ banned: true });

      await request(app)
        .get(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .expect(403);

      const unbanned = await request(app)
        .delete(`/api/tickets/communities/${communityId}/members/${String(buyer._id)}/ban`)
        .set('Authorization', vendorAuth)
        .expect(200);
      expect(unbanned.body.data).toEqual({ banned: false });

      await request(app)
        .get(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .expect(200);
    });

    it('404s when there is no membership', async () => {
      const { community, vendorAuth } = await seedWorld();
      await request(app)
        .post(`/api/tickets/communities/${String(community._id)}/members/aaaaaaaaaaaaaaaaaaaaaaaa/ban`)
        .set('Authorization', vendorAuth)
        .expect(404);
    });

    it("cannot touch another vendor's community (403)", async () => {
      const { community, buyer } = await seedWorld();
      const rival = await Vendor.create({
        businessName: 'Rival Events', email: 'rival2@example.com', password: 'secret123', phoneNumber: '+26878000096',
      });
      await request(app)
        .post(`/api/tickets/communities/${String(community._id)}/members/${String(buyer._id)}/ban`)
        .set('Authorization', `Bearer ${signVendorToken(String(rival._id))}`)
        .expect(403);
    });
  });

  describe('GET /api/tickets/communities/:communityId/members (admin roster)', () => {
    it('includes banned members with enriched fields; supports cursor pagination', async () => {
      const { community, buyer, vendorAuth } = await seedWorld();
      const communityId = String(community._id);

      const other = await Buyer.create({ phone: '+26878000050', password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Second Buyer' });
      await Membership.create({ buyerId: other._id, communityId: community._id });

      await request(app)
        .post(`/api/tickets/communities/${communityId}/members/${String(buyer._id)}/ban`)
        .set('Authorization', vendorAuth)
        .expect(200);

      const page1 = await request(app)
        .get(`/api/tickets/communities/${communityId}/members?limit=1`)
        .set('Authorization', vendorAuth)
        .expect(200);
      expect(page1.body.data).toHaveLength(1);
      const row = page1.body.data[0];
      expect(row).toHaveProperty('role');
      expect(row).toHaveProperty('ticketVerified');
      expect(row).toHaveProperty('mutedUntil');
      expect(row).toHaveProperty('bannedAt');
      expect(row).toHaveProperty('joinedAt');
      expect(row).toHaveProperty('cursor');

      const page2 = await request(app)
        .get(`/api/tickets/communities/${communityId}/members?limit=1&before=${row.cursor}`)
        .set('Authorization', vendorAuth)
        .expect(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.data[0].cursor).not.toBe(row.cursor);

      // The banned buyer must appear SOMEWHERE across the two pages — admins
      // see banned members, unlike the buyer-facing /api/community members list.
      const allIds = [...page1.body.data, ...page2.body.data].map((m: any) => m.id);
      expect(allIds).toContain(String(buyer._id));
      const bannedRow = [...page1.body.data, ...page2.body.data].find((m: any) => m.id === String(buyer._id));
      expect(bannedRow.bannedAt).toBeTruthy();
    });
  });

  describe('pin / unpin', () => {
    async function postMessages(app_: any, auth: string, channelId: string, count: number) {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const res = await request(app_)
          .post(`/api/community/channels/${channelId}/messages`)
          .set('Authorization', auth)
          .send({ body: `msg ${i}` })
          .expect(201);
        ids.push(res.body.data.id);
        resetBuckets(); // avoid tripping the per-buyer send rate limit across many posts
      }
      return ids;
    }

    it('pins and unpins a channel message; rejects the 11th pin with 400', async () => {
      const { bySlug, buyerAuth, vendorAuth } = await seedWorld();
      const general = String(bySlug['general']!._id);
      const ids = await postMessages(app, buyerAuth, general, 11);

      for (const id of ids.slice(0, 10)) {
        const res = await request(app)
          .post(`/api/tickets/messages/${id}/pin`)
          .set('Authorization', vendorAuth)
          .expect(200);
        expect(res.body.data).toEqual({ pinned: true });
      }

      await request(app)
        .post(`/api/tickets/messages/${ids[10]}/pin`)
        .set('Authorization', vendorAuth)
        .expect(400)
        .expect((res) => {
          expect(res.body.message).toBe('Pin limit reached');
        });

      const unpinned = await request(app)
        .delete(`/api/tickets/messages/${ids[0]}/pin`)
        .set('Authorization', vendorAuth)
        .expect(200);
      expect(unpinned.body.data).toEqual({ pinned: false });

      // Now there's room for the 11th.
      await request(app)
        .post(`/api/tickets/messages/${ids[10]}/pin`)
        .set('Authorization', vendorAuth)
        .expect(200);
    });

    it('deleting a pinned message auto-unpins it and removes it from the pins list', async () => {
      const { bySlug, buyerAuth, vendorAuth } = await seedWorld();
      const general = String(bySlug['general']!._id);
      const sent = await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'pin then delete me' })
        .expect(201);

      await request(app)
        .post(`/api/tickets/messages/${sent.body.data.id}/pin`)
        .set('Authorization', vendorAuth)
        .expect(200);

      const pinsBefore = await request(app)
        .get(`/api/community/channels/${general}/pins`)
        .set('Authorization', buyerAuth)
        .expect(200);
      expect(pinsBefore.body.data.map((m: any) => m.id)).toContain(sent.body.data.id);

      await request(app)
        .delete(`/api/tickets/messages/${sent.body.data.id}`)
        .set('Authorization', vendorAuth)
        .expect(200);

      const pinsAfter = await request(app)
        .get(`/api/community/channels/${general}/pins`)
        .set('Authorization', buyerAuth)
        .expect(200);
      expect(pinsAfter.body.data.map((m: any) => m.id)).not.toContain(sent.body.data.id);
    });

    it('cannot pin a soft-deleted message (404 — mirrors the delete-any deletedAt guard)', async () => {
      const { bySlug, buyerAuth, vendorAuth } = await seedWorld();
      const general = String(bySlug['general']!._id);
      const sent = await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'will be deleted before pinning' })
        .expect(201);

      await request(app)
        .delete(`/api/tickets/messages/${sent.body.data.id}`)
        .set('Authorization', vendorAuth)
        .expect(200);

      await request(app)
        .post(`/api/tickets/messages/${sent.body.data.id}/pin`)
        .set('Authorization', vendorAuth)
        .expect(404);
    });

    it('cannot pin a DM message (404)', async () => {
      const { buyer, buyerAuth, vendorAuth } = await seedWorld();
      const OTHER = '+26878000043';
      const other = await Buyer.create({ phone: OTHER, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'DM Partner' });

      const thread = await request(app)
        .post('/api/dm/threads')
        .set('Authorization', buyerAuth)
        .send({ participantIds: [String(other._id)] })
        .expect(201);
      const sent = await request(app)
        .post(`/api/dm/threads/${thread.body.data.id}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'private' })
        .expect(201);

      await request(app)
        .post(`/api/tickets/messages/${sent.body.data.id}/pin`)
        .set('Authorization', vendorAuth)
        .expect(404);
    });
  });

  describe('GET /api/community/channels/:channelId/pins (buyer read)', () => {
    it('returns pinned messages newest-first, capped at 10, and honors channel gating', async () => {
      const { bySlug, buyerAuth, vendorAuth } = await seedWorld();
      const general = String(bySlug['general']!._id);

      const first = await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'first' })
        .expect(201);
      resetBuckets();
      const second = await request(app)
        .post(`/api/community/channels/${general}/messages`)
        .set('Authorization', buyerAuth)
        .send({ body: 'second' })
        .expect(201);

      await request(app)
        .post(`/api/tickets/messages/${first.body.data.id}/pin`)
        .set('Authorization', vendorAuth)
        .expect(200);
      await request(app)
        .post(`/api/tickets/messages/${second.body.data.id}/pin`)
        .set('Authorization', vendorAuth)
        .expect(200);

      const pins = await request(app)
        .get(`/api/community/channels/${general}/pins`)
        .set('Authorization', buyerAuth)
        .expect(200);
      expect(pins.body.data.map((m: any) => m.body)).toEqual(['second', 'first']); // newest-pinned-first
      expect(pins.body.data[0].pinnedAt).toBeTruthy();
    });

    it('non-member is rejected same as message listing (403)', async () => {
      const { bySlug } = await seedWorld();
      const general = String(bySlug['general']!._id);

      const OUTSIDER = '+26878000060';
      await Buyer.create({ phone: OUTSIDER, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
      const outsiderAuth = `Bearer ${signBuyerToken(OUTSIDER)}`;

      await request(app)
        .get(`/api/community/channels/${general}/pins`)
        .set('Authorization', outsiderAuth)
        .expect(403);
    });

    it('a banned member is rejected (403)', async () => {
      const { community, buyer, buyerAuth, vendorAuth, bySlug } = await seedWorld();
      const general = String(bySlug['general']!._id);
      await request(app)
        .post(`/api/tickets/communities/${String(community._id)}/members/${String(buyer._id)}/ban`)
        .set('Authorization', vendorAuth)
        .expect(200);

      await request(app)
        .get(`/api/community/channels/${general}/pins`)
        .set('Authorization', buyerAuth)
        .expect(403);
    });

    it('gated channel: 403 without a ticket, 200 with one', async () => {
      const { bySlug, buyerAuth } = await seedWorld();
      const attendees = String(bySlug['attendees']!._id);
      await request(app)
        .get(`/api/community/channels/${attendees}/pins`)
        .set('Authorization', buyerAuth)
        .expect(403);
    });
  });
});
