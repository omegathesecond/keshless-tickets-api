import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Block } from '@models/block.model';
import { AccountActivityEvent } from '@models/accountActivityEvent.model';
import { AccountActivityService } from '@services/accountActivity.service';

const seed = (phone: string, username: string) =>
  Buyer.create({ phone, password: 'secret1', name: username, username });

describe('AccountActivityService', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('records a profile_view and lists it grouped, unread', async () => {
    const owner = await seed('+26878030101', 'owner_a');
    const actor = await seed('+26878030102', 'actor_a');

    await AccountActivityService.record({ ownerId: String(owner._id), actorType: 'buyer', actorId: String(actor._id), kind: 'profile_view' });

    const page = await AccountActivityService.list(String(owner._id));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.kind).toBe('profile_view');
    expect(page.items[0]!.count).toBe(1);
    expect(page.items[0]!.unread).toBe(true);
    expect(page.items[0]!.actor.id).toBe(String(actor._id));
    expect(page.unreadCount).toBe(1);
  });

  it('never records a self-view', async () => {
    const owner = await seed('+26878030103', 'owner_b');
    await AccountActivityService.record({ ownerId: String(owner._id), actorType: 'buyer', actorId: String(owner._id), kind: 'profile_view' });
    const count = await AccountActivityEvent.countDocuments({});
    expect(count).toBe(0);
  });

  it('groups repeated actions from the same actor into one row with a count (spec: "Thulas viewed your Story 3 times")', async () => {
    const owner = await seed('+26878030104', 'owner_c');
    const actor = await seed('+26878030105', 'actor_c');
    // Three distinct story views (different targetIds) from the same actor.
    for (const targetId of ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb', 'cccccccccccccccccccccccc']) {
      await AccountActivityEvent.create({ ownerId: owner._id, actorType: 'buyer', actorId: actor._id, kind: 'story_view', targetId });
    }
    const page = await AccountActivityService.list(String(owner._id));
    // Different targetId => different groups (one row per story), matching
    // "must open the relevant Story" (each needs its own click-through target).
    expect(page.items).toHaveLength(3);

    // Same target, same actor, same kind => ONE group with count 3.
    await AccountActivityEvent.deleteMany({});
    for (let i = 0; i < 3; i++) {
      await AccountActivityEvent.create({ ownerId: owner._id, actorType: 'buyer', actorId: actor._id, kind: 'story_view', targetId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    }
    const page2 = await AccountActivityService.list(String(owner._id));
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.count).toBe(3);
  });

  it('throttles repeat profile_view/post_view occurrences from the same actor within the window', async () => {
    const owner = await seed('+26878030106', 'owner_d');
    const actor = await seed('+26878030107', 'actor_d');
    await AccountActivityService.record({ ownerId: String(owner._id), actorType: 'buyer', actorId: String(actor._id), kind: 'profile_view' });
    await AccountActivityService.record({ ownerId: String(owner._id), actorType: 'buyer', actorId: String(actor._id), kind: 'profile_view' });
    const count = await AccountActivityEvent.countDocuments({});
    expect(count).toBe(1); // second call folded, not a new row
  });

  it('does not record when the actor has disabled activityViewHistoryDisabled (privacy toggle, spec §6)', async () => {
    const owner = await seed('+26878030108', 'owner_e');
    const actor = await Buyer.create({ phone: '+26878030109', password: 'secret1', name: 'actor_e', username: 'actor_e', activityViewHistoryDisabled: true });
    await AccountActivityService.record({ ownerId: String(owner._id), actorType: 'buyer', actorId: String(actor._id), kind: 'profile_view' });
    const count = await AccountActivityEvent.countDocuments({});
    expect(count).toBe(0);
  });

  it('does not record and does not list when owner/actor have blocked each other either way', async () => {
    const owner = await seed('+26878030110', 'owner_f');
    const actor = await seed('+26878030111', 'actor_f');
    await Block.create({ blockerId: owner._id, blockedId: actor._id });

    await AccountActivityService.record({ ownerId: String(owner._id), actorType: 'buyer', actorId: String(actor._id), kind: 'profile_view' });
    expect(await AccountActivityEvent.countDocuments({})).toBe(0);

    // A row that exists despite a LATER block must also be filtered out of list().
    await AccountActivityEvent.create({ ownerId: owner._id, actorType: 'buyer', actorId: actor._id, kind: 'post_view', targetId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    const page = await AccountActivityService.list(String(owner._id));
    expect(page.items).toHaveLength(0);
  });

  it('markRead clears only the targeted group; markAllRead clears everything', async () => {
    const owner = await seed('+26878030112', 'owner_g');
    const actorA = await seed('+26878030113', 'actor_g1');
    const actorB = await seed('+26878030114', 'actor_g2');
    await AccountActivityEvent.create({ ownerId: owner._id, actorType: 'buyer', actorId: actorA._id, kind: 'profile_view' });
    await AccountActivityEvent.create({ ownerId: owner._id, actorType: 'buyer', actorId: actorB._id, kind: 'profile_view' });

    await AccountActivityService.markRead(String(owner._id), { actorType: 'buyer', actorId: String(actorA._id), kind: 'profile_view' });
    let page = await AccountActivityService.list(String(owner._id));
    expect(page.unreadCount).toBe(1);
    expect(page.items.find((i) => i.actor.id === String(actorA._id))!.unread).toBe(false);
    expect(page.items.find((i) => i.actor.id === String(actorB._id))!.unread).toBe(true);

    await AccountActivityService.markAllRead(String(owner._id));
    page = await AccountActivityService.list(String(owner._id));
    expect(page.unreadCount).toBe(0);
    expect(page.items.every((i) => !i.unread)).toBe(true);
  });

  it('sorts groups by most recent interaction', async () => {
    const owner = await seed('+26878030115', 'owner_h');
    const actorA = await seed('+26878030116', 'actor_h1');
    const actorB = await seed('+26878030117', 'actor_h2');
    const older = await AccountActivityEvent.create({ ownerId: owner._id, actorType: 'buyer', actorId: actorA._id, kind: 'profile_view' });
    await AccountActivityEvent.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 60_000) } });
    await AccountActivityEvent.create({ ownerId: owner._id, actorType: 'buyer', actorId: actorB._id, kind: 'profile_view' });

    const page = await AccountActivityService.list(String(owner._id));
    expect(page.items.map((i) => i.actor.id)).toEqual([String(actorB._id), String(actorA._id)]);
  });
});
