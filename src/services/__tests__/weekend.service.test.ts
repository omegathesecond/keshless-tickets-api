import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { WeekendStatus } from '@models/weekendStatus.model';
import { WeekendRequest } from '@models/weekendRequest.model';
import { FollowService } from '@services/follow.service';
import { BlockService } from '@services/block.service';
import { WeekendService } from '@services/weekend.service';

const DAY_MS = 24 * 60 * 60 * 1000;
let phoneCounter = 0;

async function seedBuyer(username: string): Promise<IBuyer> {
  phoneCounter += 1;
  return Buyer.create({ phone: `+2687840${String(1000 + phoneCounter)}`, password: 'secret1', username, avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
}

async function seedEvent(opts: { startInDays: number; status?: EventStatus }) {
  const now = Date.now();
  const startTime = new Date(now + opts.startInDays * DAY_MS);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Weekend Test Event',
    venue: 'Test Venue',
    eventDate: startTime,
    startTime,
    endTime: new Date(startTime.getTime() + 3 * 60 * 60 * 1000),
    status: opts.status ?? EventStatus.PUBLISHED,
    publishedAt: new Date(now - 60 * 60 * 1000),
  });
  return event;
}

describe('WeekendService', () => {
  beforeAll(async () => {
    await connectTestDb();
    await WeekendStatus.init();
    await WeekendRequest.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  describe('upsertStatus', () => {
    it('rejects an invalid statusType', async () => {
      const buyer = await seedBuyer('u_invalid');
      await expect(WeekendService.upsertStatus(buyer, { statusType: 'not_a_real_status' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('requires a message for a custom status', async () => {
      const buyer = await seedBuyer('u_custom');
      await expect(WeekendService.upsertStatus(buyer, { statusType: 'custom' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(WeekendService.upsertStatus(buyer, { statusType: 'custom', message: '   ' })).rejects.toMatchObject({ statusCode: 400 });

      const dto = await WeekendService.upsertStatus(buyer, { statusType: 'custom', message: 'Chilling at the beach' });
      expect(dto.statusType).toBe('custom');
      expect(dto.message).toBe('Chilling at the beach');
    });

    it('defaults audience to public when omitted or invalid', async () => {
      const buyer = await seedBuyer('u_aud_default');
      const dto = await WeekendService.upsertStatus(buyer, { statusType: 'bored' });
      expect(dto.audience).toBe('public');

      const dto2 = await WeekendService.upsertStatus(buyer, { statusType: 'bored', audience: 'not-a-real-audience' });
      expect(dto2.audience).toBe('public');
    });

    it('requires at least one viewer id when audience is "selected"', async () => {
      const buyer = await seedBuyer('u_selected');
      await expect(WeekendService.upsertStatus(buyer, { statusType: 'bored', audience: 'selected' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(WeekendService.upsertStatus(buyer, { statusType: 'bored', audience: 'selected', selectedViewerIds: [] })).rejects.toMatchObject({ statusCode: 400 });

      const viewer = await seedBuyer('u_viewer_selected');
      const dto = await WeekendService.upsertStatus(buyer, { statusType: 'bored', audience: 'selected', selectedViewerIds: [String(viewer._id)] });
      expect(dto.audience).toBe('selected');
    });

    describe('going_to_event validation', () => {
      it('rejects a missing/invalid eventId', async () => {
        const buyer = await seedBuyer('u_gte_missing');
        await expect(WeekendService.upsertStatus(buyer, { statusType: 'going_to_event' })).rejects.toMatchObject({ statusCode: 400 });
        await expect(WeekendService.upsertStatus(buyer, { statusType: 'going_to_event', eventId: 'not-a-hex24' })).rejects.toMatchObject({ statusCode: 400 });
      });

      it('rejects an event that does not exist', async () => {
        const buyer = await seedBuyer('u_gte_notfound');
        await expect(
          WeekendService.upsertStatus(buyer, { statusType: 'going_to_event', eventId: String(new mongoose.Types.ObjectId()) })
        ).rejects.toMatchObject({ statusCode: 404 });
      });

      it('rejects an event that has already ended', async () => {
        const buyer = await seedBuyer('u_gte_ended');
        const event = await seedEvent({ startInDays: -2 });
        await expect(WeekendService.upsertStatus(buyer, { statusType: 'going_to_event', eventId: String(event._id) })).rejects.toMatchObject({ statusCode: 400 });
      });

      it('rejects a cancelled event even if still upcoming', async () => {
        const buyer = await seedBuyer('u_gte_cancelled');
        const event = await seedEvent({ startInDays: 3, status: EventStatus.CANCELLED });
        await expect(WeekendService.upsertStatus(buyer, { statusType: 'going_to_event', eventId: String(event._id) })).rejects.toMatchObject({ statusCode: 400 });
      });

      it('accepts an upcoming, non-cancelled event and ties activeUntil to the event end time', async () => {
        const buyer = await seedBuyer('u_gte_ok');
        const event = await seedEvent({ startInDays: 3 });
        const dto = await WeekendService.upsertStatus(buyer, { statusType: 'going_to_event', eventId: String(event._id) });
        expect(dto.event?.id).toBe(String(event._id));

        const doc = await WeekendStatus.findOne({ buyerId: buyer._id });
        expect(doc!.activeUntil.getTime()).toBe(event.endTime.getTime());
      });
    });

    it('upserts into the single existing row rather than creating a second one', async () => {
      const buyer = await seedBuyer('u_upsert_once');
      await WeekendService.upsertStatus(buyer, { statusType: 'bored' });
      await WeekendService.upsertStatus(buyer, { statusType: 'staying_in' });
      expect(await WeekendStatus.countDocuments({ buyerId: buyer._id })).toBe(1);
      const doc = await WeekendStatus.findOne({ buyerId: buyer._id });
      expect(doc!.statusType).toBe('staying_in');
    });

    it('clears a stale eventId when switching away from going_to_event', async () => {
      const buyer = await seedBuyer('u_switch_away');
      const event = await seedEvent({ startInDays: 3 });
      await WeekendService.upsertStatus(buyer, { statusType: 'going_to_event', eventId: String(event._id) });
      await WeekendService.upsertStatus(buyer, { statusType: 'bored' });
      const doc = await WeekendStatus.findOne({ buyerId: buyer._id });
      expect(doc!.eventId).toBeUndefined();
    });
  });

  describe('getForViewer', () => {
    it('throws 404 for an unknown username', async () => {
      await expect(WeekendService.getForViewer(null, 'nobody_here')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('returns hasStatus:false when the owner has no active status', async () => {
      const owner = await seedBuyer('u_no_status');
      const result = await WeekendService.getForViewer(null, owner.username!);
      expect(result).toEqual({ username: owner.username, hasStatus: false, status: null });
    });

    it('hides a status from a blocked viewer either direction, even for a public audience', async () => {
      const owner = await seedBuyer('u_blk_owner');
      const viewer = await seedBuyer('u_blk_viewer');
      await WeekendService.upsertStatus(owner, { statusType: 'bored', audience: 'public' });

      await BlockService.block(owner, String(viewer._id));
      let result = await WeekendService.getForViewer(viewer, owner.username!);
      expect(result.hasStatus).toBe(false);

      await BlockService.unblock(owner, String(viewer._id));
      await BlockService.block(viewer, String(owner._id));
      result = await WeekendService.getForViewer(viewer, owner.username!);
      expect(result.hasStatus).toBe(false);
    });

    it('gates an only_me status from every other viewer, including a signed-out one', async () => {
      const owner = await seedBuyer('u_only_me');
      const viewer = await seedBuyer('u_only_me_viewer');
      await WeekendService.upsertStatus(owner, { statusType: 'bored', audience: 'only_me' });

      expect((await WeekendService.getForViewer(null, owner.username!)).hasStatus).toBe(false);
      expect((await WeekendService.getForViewer(viewer, owner.username!)).hasStatus).toBe(false);
    });

    it('gates a followers-only status to followers of the owner', async () => {
      const owner = await seedBuyer('u_followers_owner');
      const follower = await seedBuyer('u_followers_yes');
      const stranger = await seedBuyer('u_followers_no');
      await WeekendService.upsertStatus(owner, { statusType: 'bored', audience: 'followers' });
      await FollowService.follow(follower, 'buyer', String(owner._id));

      expect((await WeekendService.getForViewer(stranger, owner.username!)).hasStatus).toBe(false);
      expect((await WeekendService.getForViewer(null, owner.username!)).hasStatus).toBe(false);
      const result = await WeekendService.getForViewer(follower, owner.username!);
      expect(result.hasStatus).toBe(true);
    });

    it('gates a selected-people status to the ids on the status', async () => {
      const owner = await seedBuyer('u_selected_owner');
      const chosen = await seedBuyer('u_selected_yes');
      const notChosen = await seedBuyer('u_selected_no');
      await WeekendService.upsertStatus(owner, { statusType: 'bored', audience: 'selected', selectedViewerIds: [String(chosen._id)] });

      expect((await WeekendService.getForViewer(notChosen, owner.username!)).hasStatus).toBe(false);
      expect((await WeekendService.getForViewer(chosen, owner.username!)).hasStatus).toBe(true);
    });

    it('lets the owner see their own status regardless of audience', async () => {
      const owner = await seedBuyer('u_own_bypass');
      await WeekendService.upsertStatus(owner, { statusType: 'bored', audience: 'only_me' });
      const result = await WeekendService.getForViewer(owner, owner.username!);
      expect(result.hasStatus).toBe(true);
      expect(result.status?.audience).toBe('only_me');
    });
  });

  describe('feed ranking (getWhoHasPlansCards / getLookingForPlansCards)', () => {
    it('never returns the viewer themselves', async () => {
      const viewer = await seedBuyer('u_feed_self');
      await WeekendService.upsertStatus(viewer, { statusType: 'have_plans', audience: 'public' });
      const cards = await WeekendService.getWhoHasPlansCards(viewer, 10, []);
      expect(cards.find((c) => c.user.id === String(viewer._id))).toBeUndefined();
    });

    it('excludes candidates blocked in either direction', async () => {
      const viewer = await seedBuyer('u_feed_viewer_blk');
      const blockedByMe = await seedBuyer('u_feed_i_blocked');
      const blockedMe = await seedBuyer('u_feed_blocked_me');
      const visible = await seedBuyer('u_feed_visible');
      await WeekendService.upsertStatus(blockedByMe, { statusType: 'have_plans', audience: 'public' });
      await WeekendService.upsertStatus(blockedMe, { statusType: 'have_plans', audience: 'public' });
      await WeekendService.upsertStatus(visible, { statusType: 'have_plans', audience: 'public' });
      await BlockService.block(viewer, String(blockedByMe._id));
      await BlockService.block(blockedMe, String(viewer._id));

      const cards = await WeekendService.getWhoHasPlansCards(viewer, 10, []);
      const ids = cards.map((c) => c.user.id);
      expect(ids).not.toContain(String(blockedByMe._id));
      expect(ids).not.toContain(String(blockedMe._id));
      expect(ids).toContain(String(visible._id));
    });

    it('respects the audience $or clause: followers-only only shows to followers, selected only to chosen viewers', async () => {
      const viewer = await seedBuyer('u_feed_aud_viewer');
      const followedPoster = await seedBuyer('u_feed_aud_followers');
      const unrelatedPoster = await seedBuyer('u_feed_aud_unrel');
      const selectedPoster = await seedBuyer('u_feed_aud_selected');

      await WeekendService.upsertStatus(followedPoster, { statusType: 'have_plans', audience: 'followers' });
      await WeekendService.upsertStatus(unrelatedPoster, { statusType: 'have_plans', audience: 'followers' });
      await WeekendService.upsertStatus(selectedPoster, { statusType: 'have_plans', audience: 'selected', selectedViewerIds: [String(viewer._id)] });
      await FollowService.follow(viewer, 'buyer', String(followedPoster._id));

      const cards = await WeekendService.getWhoHasPlansCards(viewer, 10, []);
      const ids = cards.map((c) => c.user.id);
      expect(ids).toContain(String(followedPoster._id));
      expect(ids).toContain(String(selectedPoster._id));
      expect(ids).not.toContain(String(unrelatedPoster._id));
    });

    it('only_me statuses never appear in either feed rail', async () => {
      const viewer = await seedBuyer('u_feed_only_me_vw');
      const owner = await seedBuyer('u_feed_only_me_owner');
      await WeekendService.upsertStatus(owner, { statusType: 'have_plans', audience: 'only_me' });
      const cards = await WeekendService.getWhoHasPlansCards(viewer, 10, []);
      expect(cards.map((c) => c.user.id)).not.toContain(String(owner._id));
    });

    it('ranks followed candidates ahead of everyone else', async () => {
      const viewer = await seedBuyer('u_feed_tier_viewer');
      const followed1 = await seedBuyer('u_feed_tier_f1');
      const followed2 = await seedBuyer('u_feed_tier_f2');
      const other1 = await seedBuyer('u_feed_tier_o1');
      const other2 = await seedBuyer('u_feed_tier_o2');
      for (const b of [followed1, followed2, other1, other2]) {
        await WeekendService.upsertStatus(b, { statusType: 'have_plans', audience: 'public' });
      }
      await FollowService.follow(viewer, 'buyer', String(followed1._id));
      await FollowService.follow(viewer, 'buyer', String(followed2._id));

      const cards = await WeekendService.getWhoHasPlansCards(viewer, 10, []);
      const ids = cards.map((c) => c.user.id);
      const followedIndexes = [ids.indexOf(String(followed1._id)), ids.indexOf(String(followed2._id))];
      const otherIndexes = [ids.indexOf(String(other1._id)), ids.indexOf(String(other2._id))];
      expect(Math.max(...followedIndexes)).toBeLessThan(Math.min(...otherIndexes));
    });

    it('keeps "who has plans" and "looking for plans" status types in separate rails', async () => {
      const viewer = await seedBuyer('u_feed_sep_viewer');
      const hasPlans = await seedBuyer('u_feed_sep_has');
      const lookingForPlans = await seedBuyer('u_feed_sep_look');
      await WeekendService.upsertStatus(hasPlans, { statusType: 'have_plans', audience: 'public' });
      await WeekendService.upsertStatus(lookingForPlans, { statusType: 'bored', audience: 'public' });

      const hasPlansCards = await WeekendService.getWhoHasPlansCards(viewer, 10, []);
      expect(hasPlansCards.map((c) => c.user.id)).toContain(String(hasPlans._id));
      expect(hasPlansCards.map((c) => c.user.id)).not.toContain(String(lookingForPlans._id));

      const lookingForPlansCards = await WeekendService.getLookingForPlansCards(viewer, 10, []);
      expect(lookingForPlansCards.map((c) => c.user.id)).toContain(String(lookingForPlans._id));
      expect(lookingForPlansCards.map((c) => c.user.id)).not.toContain(String(hasPlans._id));
    });
  });

  describe('createRequest', () => {
    it('rejects an invalid kind', async () => {
      const sender = await seedBuyer('u_req_invalid_kind');
      const recipient = await seedBuyer('u_req_invalid_kind_r');
      await expect(WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'not_a_real_kind' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects requesting yourself', async () => {
      const sender = await seedBuyer('u_req_self');
      await expect(WeekendService.createRequest(sender, { recipientId: String(sender._id), kind: 'request_to_meet' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('rejects an unknown recipient', async () => {
      const sender = await seedBuyer('u_req_unknown');
      await expect(
        WeekendService.createRequest(sender, { recipientId: String(new mongoose.Types.ObjectId()), kind: 'request_to_meet' })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('blocks a request between blocked users, either direction', async () => {
      const sender = await seedBuyer('u_req_blk_sender');
      const recipient = await seedBuyer('u_req_blk_recipient');
      await BlockService.block(sender, String(recipient._id));
      await expect(WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' })).rejects.toMatchObject({ statusCode: 403 });

      const sender2 = await seedBuyer('u_req_blk_sender2');
      const recipient2 = await seedBuyer('u_req_blk_recipient2');
      await BlockService.block(recipient2, String(sender2._id));
      await expect(WeekendService.createRequest(sender2, { recipientId: String(recipient2._id), kind: 'request_to_meet' })).rejects.toMatchObject({ statusCode: 403 });
    });

    it('requires an event for kinds that need one', async () => {
      const sender = await seedBuyer('u_req_needs_event');
      const recipient = await seedBuyer('u_req_needs_event_r');
      await expect(WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'invite_to_event' })).rejects.toMatchObject({ statusCode: 400 });
      await expect(WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'buy_ticket' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('does not require an event for kinds that do not need one', async () => {
      const sender = await seedBuyer('u_req_no_evt');
      const recipient = await seedBuyer('u_req_no_evt_r');
      const result = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' });
      expect(result.status).toBe('pending');
    });

    it('rejects a missing or already-ended event for an event-required kind', async () => {
      const sender = await seedBuyer('u_req_bad_event');
      const recipient = await seedBuyer('u_req_bad_event_r');
      await expect(
        WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'invite_to_event', eventId: String(new mongoose.Types.ObjectId()) })
      ).rejects.toMatchObject({ statusCode: 404 });

      const ended = await seedEvent({ startInDays: -1 });
      await expect(
        WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'invite_to_event', eventId: String(ended._id) })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('is idempotent: an identical still-pending request returns the same row instead of duplicating', async () => {
      const sender = await seedBuyer('u_req_dupe_sender');
      const recipient = await seedBuyer('u_req_dupe_recipient');
      const first = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet', message: 'hey' });
      const second = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet', message: 'again' });
      expect(second.id).toBe(first.id);
      expect(await WeekendRequest.countDocuments({ senderId: sender._id, recipientId: recipient._id, kind: 'request_to_meet' })).toBe(1);
    });

    it('allows a new request once the prior one is no longer pending', async () => {
      const sender = await seedBuyer('u_req_reopen_sender');
      const recipient = await seedBuyer('u_req_reopen_r');
      const first = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' });
      await WeekendService.cancelRequest(sender, first.id);
      const second = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' });
      expect(second.id).not.toBe(first.id);
    });
  });

  describe('respondToRequest', () => {
    it('rejects a response from anyone but the recipient', async () => {
      const sender = await seedBuyer('u_resp_sender');
      const recipient = await seedBuyer('u_resp_recipient');
      const outsider = await seedBuyer('u_resp_outsider');
      const { id } = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' });
      await expect(WeekendService.respondToRequest(outsider, id, true)).rejects.toMatchObject({ statusCode: 403 });
      await expect(WeekendService.respondToRequest(sender, id, true)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('accepts a pending request and flips its status', async () => {
      const sender = await seedBuyer('u_resp_accept_sender');
      const recipient = await seedBuyer('u_resp_accept_r');
      const { id } = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' });
      await WeekendService.respondToRequest(recipient, id, true);
      const row = await WeekendRequest.findById(id);
      expect(row!.status).toBe('accepted');
      expect(row!.respondedAt).toBeTruthy();
    });

    it('declines a pending request and flips its status', async () => {
      const sender = await seedBuyer('u_resp_decline_s');
      const recipient = await seedBuyer('u_resp_decline_r');
      const { id } = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' });
      await WeekendService.respondToRequest(recipient, id, false);
      const row = await WeekendRequest.findById(id);
      expect(row!.status).toBe('declined');
    });

    it('rejects responding to a request that is no longer pending', async () => {
      const sender = await seedBuyer('u_resp_twice_sender');
      const recipient = await seedBuyer('u_resp_twice_r');
      const { id } = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' });
      await WeekendService.respondToRequest(recipient, id, true);
      await expect(WeekendService.respondToRequest(recipient, id, false)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects an unknown request id', async () => {
      const recipient = await seedBuyer('u_resp_unknown');
      await expect(WeekendService.respondToRequest(recipient, String(new mongoose.Types.ObjectId()), true)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('cancelRequest', () => {
    it('rejects a cancel from anyone but the sender', async () => {
      const sender = await seedBuyer('u_cancel_sender');
      const recipient = await seedBuyer('u_cancel_recipient');
      const { id } = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' });
      await expect(WeekendService.cancelRequest(recipient, id)).rejects.toMatchObject({ statusCode: 403 });
    });

    it('cancels a pending request', async () => {
      const sender = await seedBuyer('u_cancel_ok_sender');
      const recipient = await seedBuyer('u_cancel_ok_r');
      const { id } = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' });
      await WeekendService.cancelRequest(sender, id);
      const row = await WeekendRequest.findById(id);
      expect(row!.status).toBe('cancelled');
    });

    it('rejects cancelling a request that is no longer pending', async () => {
      const sender = await seedBuyer('u_cancel_twice_s');
      const recipient = await seedBuyer('u_cancel_twice_r');
      const { id } = await WeekendService.createRequest(sender, { recipientId: String(recipient._id), kind: 'request_to_meet' });
      await WeekendService.cancelRequest(sender, id);
      await expect(WeekendService.cancelRequest(sender, id)).rejects.toMatchObject({ statusCode: 409 });
    });
  });
});
