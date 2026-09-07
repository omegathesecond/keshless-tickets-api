jest.mock('@services/push.service', () => ({
  PushService: { sendToBuyer: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@utils/buyerOnline.util', () => ({
  isBuyerOnline: jest.fn().mockResolvedValue(true), // inbox-only in these tests
  PRESENCE_STALE_MS: 120000,
}));
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Membership } from '@models/membership.model';
import { Notification } from '@models/notification.model';
import { CommunityService } from '@services/community.service';
import { Channel } from '@models/channel.model';
import { FollowService } from '@services/follow.service';
import { DmThreadService } from '@services/dmThread.service';
import { MessageService } from '@services/message.service';
import { resetBuckets } from '@utils/rateLimit.util';

async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 150)); // dispatchAsync settles
}

async function seedBuyer(phone: string, username: string): Promise<IBuyer> {
  return Buyer.create({ phone, password: 'secret1', name: username, username });
}

describe('notification triggers', () => {
  beforeAll(connectTestDb);
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('mutual follow notifies the followed-back party once', async () => {
    const a = await seedBuyer('+26878000001', 'alpha_one');
    const b = await seedBuyer('+26878000002', 'beta_two');

    await FollowService.follow(a, 'buyer', String(b._id));
    await flushAsync();
    expect(await Notification.countDocuments({})).toBe(0); // not mutual yet

    await FollowService.follow(b, 'buyer', String(a._id));
    await flushAsync();
    const n = await Notification.findOne({ recipientId: a._id, type: 'friend' });
    expect(n).not.toBeNull();
    expect(n!.title).toBe('beta_two');
    // The notified party (a) is being told about their new friend (b) — the
    // data payload must carry b's identity so the client can route straight
    // to b's profile, matching who buyerId already points at.
    expect(n!.data['buyerId']).toBe(String(b._id));
    expect(n!.data['username']).toBe('beta_two');
    expect(await Notification.countDocuments({})).toBe(1);
  });

  it('announcement fans out to un-banned members and organizer followers, deduped', async () => {
    const vendor = await Vendor.create({
      businessName: 'Piano Republic Events', email: 'o@e.com', password: 'secret123', phoneNumber: '+26878000099',
    });
    const seeded = await seedPublishedEvent({ vendorId: vendor._id as any });
    const { community } = await CommunityService.ensureForEvent(seeded.eventId, String(vendor._id));

    const member = await seedBuyer('+26878000001', 'member_one');
    const banned = await seedBuyer('+26878000002', 'banned_two');
    const followerAndMember = await seedBuyer('+26878000003', 'both_three');
    const followerOnly = await seedBuyer('+26878000004', 'follower_four');

    await Membership.create({ buyerId: member._id, communityId: community._id });
    await Membership.create({ buyerId: banned._id, communityId: community._id, bannedAt: new Date() });
    await Membership.create({ buyerId: followerAndMember._id, communityId: community._id });
    await FollowService.follow(followerAndMember, 'organizer', String(vendor._id));
    await FollowService.follow(followerOnly, 'organizer', String(vendor._id));

    await MessageService.postAnnouncement(seeded.eventId, String(vendor._id), 'Gates open 18:00 — bring ID!');
    await flushAsync();

    const notes = await Notification.find({ type: 'announcement' });
    const recipients = notes.map((n) => String(n.recipientId)).sort();
    expect(recipients).toEqual(
      [String(member._id), String(followerAndMember._id), String(followerOnly._id)].sort()
    );
    expect(notes[0]!.title).toBe('Piano Republic Events');
    expect(notes[0]!.data['eventId']).toBe(seeded.eventId);
  });

  it('dm message notifies the other participant; channel @mention notifies mentioned member only', async () => {
    const seeded = await seedPublishedEvent();
    const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
    const general = (await Channel.findOne({ communityId: community._id, slug: 'general' }))!;

    const sender = await seedBuyer('+26878000001', 'sender_one');
    const friend = await seedBuyer('+26878000002', 'friend_two');
    const outsider = await seedBuyer('+26878000003', 'outsider_three');
    for (const b of [sender, friend]) await Membership.create({ buyerId: b._id, communityId: community._id });

    const thread = await DmThreadService.openThread(sender, [String(friend._id)]);
    resetBuckets();
    await MessageService.sendDmMessage(String(thread._id), { type: 'buyer', id: String(sender._id) }, { body: 'psst' });
    await flushAsync();
    const dmNote = await Notification.findOne({ recipientId: friend._id, type: 'dm' });
    expect(dmNote).not.toBeNull();
    expect(dmNote!.title).toBe('sender_one');
    expect(await Notification.countDocuments({ recipientId: sender._id })).toBe(0);

    // mention: friend_two is a member (notified); outsider_three is not (ignored)
    resetBuckets();
    const msg = await MessageService.sendMessage(String(general._id), { type: 'buyer', id: String(sender._id) }, {
      body: 'yo @friend_two and @outsider_three check this',
    });
    await flushAsync();
    expect(await Notification.countDocuments({ recipientId: friend._id, type: 'mention' })).toBe(1);
    expect(await Notification.countDocuments({ recipientId: outsider._id, type: 'mention' })).toBe(0);

    const { Message } = await import('@models/message.model');
    const stored = await Message.findById(msg.id);
    expect(stored!.mentions.map(String)).toEqual([String(friend._id)]);

    // uppercase mention resolves; email fragments never do
    resetBuckets();
    await MessageService.sendMessage(String(general._id), { type: 'buyer', id: String(sender._id) }, {
      body: 'ping @FRIEND_TWO — and mail me at contact@friendmail.com',
    });
    await flushAsync();
    expect(await Notification.countDocuments({ recipientId: friend._id, type: 'mention' })).toBe(2);
  });
});
