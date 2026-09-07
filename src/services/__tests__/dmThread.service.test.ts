import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Membership } from '@models/membership.model';
import { CommunityService } from '@services/community.service';
import { FollowService } from '@services/follow.service';
import { Follow } from '@models/follow.model';
import { MeetupRequest } from '@models/meetupRequest.model';
import { BlockService } from '@services/block.service';
import { DmThreadService } from '@services/dmThread.service';
import { DmThread } from '@models/dmThread.model';
import { resetBuckets } from '@utils/rateLimit.util';

async function seedBuyer(phone: string, dmPrivacy: 'community' | 'friends' = 'community'): Promise<IBuyer> {
  return Buyer.create({ phone, password: 'secret1', name: `B${phone.slice(-4)}`, dmPrivacy });
}

async function makeFriends(a: IBuyer, b: IBuyer) {
  await FollowService.follow(a, 'buyer', String(b._id));
  await FollowService.follow(b, 'buyer', String(a._id));
}

const befriend = async (a: IBuyer, b: IBuyer) => {
  await Follow.create({ followerType: 'buyer', followerId: a._id, targetType: 'buyer', targetId: b._id });
  await Follow.create({ followerType: 'buyer', followerId: b._id, targetType: 'buyer', targetId: a._id });
};
const acceptMeetup = (a: IBuyer, b: IBuyer) =>
  MeetupRequest.create({ requesterId: a._id, targetId: b._id, status: 'accepted' });

async function shareCommunity(...buyers: IBuyer[]) {
  const seeded = await seedPublishedEvent();
  const { community } = await CommunityService.ensureForEvent(seeded.eventId, seeded.vendorId);
  for (const b of buyers) await Membership.create({ buyerId: b._id, communityId: community._id });
}

describe('DmThreadService', () => {
  beforeAll(async () => {
    await connectTestDb();
    await DmThread.init(); // unique index must exist before pairKey race test
  });
  beforeEach(resetBuckets);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('a stranger, a friend, and an accepted-meetup partner are all allowed — no connection required', async () => {
    const a = await seedBuyer('+26878000001');
    const b = await seedBuyer('+26878000002');
    await expect(DmThreadService.assertCanDm(a, b)).resolves.toBeUndefined();
    await befriend(a, b);
    await expect(DmThreadService.assertCanDm(a, b)).resolves.toBeUndefined();
    const c = await seedBuyer('+26878000021');
    await acceptMeetup(c, a); // c requested a, accepted — either direction counts
    await expect(DmThreadService.assertCanDm(a, c)).resolves.toBeUndefined();
  });

  it('dmPrivacy no longer changes the gate: a "friends"-only stranger is still allowed', async () => {
    const a = await seedBuyer('+26878000001');
    const b = await seedBuyer('+26878000002', 'friends');
    await expect(DmThreadService.assertCanDm(a, b)).resolves.toBeUndefined();

    await makeFriends(a, b);
    await expect(DmThreadService.assertCanDm(a, b)).resolves.toBeUndefined();
  });

  it('block beats everything, both directions', async () => {
    const a = await seedBuyer('+26878000001');
    const b = await seedBuyer('+26878000002');
    await makeFriends(a, b);
    await BlockService.block(b, String(a._id));
    await expect(DmThreadService.assertCanDm(a, b)).rejects.toMatchObject({ statusCode: 403 });
    await expect(DmThreadService.assertCanDm(b, a)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('1:1 threads dedupe via pairKey, including the concurrent race', async () => {
    const a = await seedBuyer('+26878000001');
    const b = await seedBuyer('+26878000002');
    await shareCommunity(a, b);
    await befriend(a, b);

    const t1 = await DmThreadService.openThread(a, [String(b._id)]);
    const t2 = await DmThreadService.openThread(b, [String(a._id)]);
    expect(String(t2._id)).toBe(String(t1._id));
    expect(t1.isGroup).toBe(false);
    expect(await DmThread.countDocuments({})).toBe(1);

    // race: existence check misses, create hits the unique pairKey index
    const spy = jest.spyOn(DmThread, 'findOne').mockResolvedValueOnce(null as any);
    try {
      const t3 = await DmThreadService.openThread(a, [String(b._id)]);
      expect(String(t3._id)).toBe(String(t1._id));
    } finally {
      spy.mockRestore();
    }
  });

  it('1:1 dedupe survives mixed-case participant ids', async () => {
    const a = await seedBuyer('+26878000001');
    const b = await seedBuyer('+26878000002');
    await shareCommunity(a, b);
    await befriend(a, b);

    const t1 = await DmThreadService.openThread(a, [String(b._id)]);
    const t2 = await DmThreadService.openThread(a, [String(b._id).toUpperCase()]);
    expect(String(t2._id)).toBe(String(t1._id));
    expect(await DmThread.countDocuments({})).toBe(1);
  });

  it('groups: 2..9 others ok, 0 or 10+ rejected, creator must not be blocked by/blocking ANY member', async () => {
    const a = await seedBuyer('+26878000001');
    const others: IBuyer[] = [];
    for (let i = 0; i < 3; i++) others.push(await seedBuyer(`+2687800001${i}`));
    await shareCommunity(a, ...others);
    for (const m of others) await befriend(a, m);

    const group = await DmThreadService.openThread(a, others.map((o) => String(o._id)));
    expect(group.isGroup).toBe(true);
    expect(group.participants).toHaveLength(4);

    await expect(DmThreadService.openThread(a, [])).rejects.toMatchObject({ statusCode: 400 });

    const blocked = await seedBuyer('+26878000099');
    await BlockService.block(a, String(blocked._id));
    await expect(
      DmThreadService.openThread(a, [...others.map((o) => String(o._id)), String(blocked._id)])
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rate limits rapid thread creation', async () => {
    const a = await seedBuyer('+26878000001');
    const others: IBuyer[] = [];
    for (let i = 0; i < 7; i++) others.push(await seedBuyer(`+2687800002${i}`));
    await shareCommunity(a, ...others);
    for (const m of others) await befriend(a, m);

    resetBuckets();
    for (let i = 0; i < 5; i++) {
      await DmThreadService.openThread(a, [String(others[i]!._id), String(others[(i + 1) % 7]!._id)]);
    }
    await expect(
      DmThreadService.openThread(a, [String(others[5]!._id), String(others[6]!._id)])
    ).rejects.toMatchObject({ statusCode: 429 });
  });

  it('requireDmAccess: participant ok; non-participant and unknown get 404', async () => {
    const a = await seedBuyer('+26878000001');
    const b = await seedBuyer('+26878000002');
    const c = await seedBuyer('+26878000003');
    await shareCommunity(a, b);
    await befriend(a, b);
    const t = await DmThreadService.openThread(a, [String(b._id)]);

    await expect(DmThreadService.requireDmAccess(String(t._id), { type: 'buyer', id: String(b._id) })).resolves.toBeDefined();
    await expect(DmThreadService.requireDmAccess(String(t._id), { type: 'buyer', id: String(c._id) })).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      DmThreadService.requireDmAccess(String(new mongoose.Types.ObjectId()), { type: 'buyer', id: String(a._id) })
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(DmThreadService.requireDmAccess('garbage', { type: 'buyer', id: String(a._id) })).rejects.toMatchObject({ statusCode: 404 });
  });
});
