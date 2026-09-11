import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '@/__tests__/helpers/mongo';
import { signBuyerToken } from '@/__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventPlan } from '@models/eventPlan.model';
import { EventPlanMember } from '@models/eventPlanMember.model';
import { Block } from '@models/block.model';

const auth = (phone: string) => ({ Authorization: `Bearer ${signBuyerToken(phone)}` });
const ADMIN = '+26878422613';
const FRIEND = '+26878000001';
const OUTSIDER = '+26878000002';

const AVATAR = 'https://cdn.carrottickets.com/test/avatar.jpg';

async function makeEvent(overrides: Partial<any> = {}, futureDays = 30) {
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Test Event',
    venue: 'Test Venue',
    eventDate: new Date(Date.now() + futureDays * 24 * 60 * 60 * 1000),
    startTime: new Date(Date.now() + futureDays * 24 * 60 * 60 * 1000),
    endTime: new Date(Date.now() + futureDays * 24 * 60 * 60 * 1000 + 3600_000),
    ticketTypes: [{ name: 'GA', price: 100, quantity: 10, available: 10 }],
    ...overrides,
  });
}

async function makeBuyer(phone: string, name: string, username: string) {
  return Buyer.create({ phone, password: 'secret1', avatarUrl: AVATAR, name, username });
}

describe('event plan routes', () => {
  beforeAll(async () => {
    await connectTestDb();
    await EventPlan.init();
    await EventPlanMember.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('creates a public open-join plan with an invitee and lists it on the event page', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const friend = await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();

    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({
        eventId: String(event._id),
        name: 'Pregame at the bar',
        description: 'Meet before doors open',
        visibility: 'public',
        joinPolicy: 'open',
        meetingPoint: 'Main gate',
        transport: { seats: 4, costEstimate: 50 },
        inviteeIds: [String(friend._id)],
      })
      .expect(201);

    expect(created.body.data.name).toBe('Pregame at the bar');
    expect(created.body.data.viewer.isAdmin).toBe(true);
    expect(created.body.data.memberCount).toBe(1);

    // Anonymous listing on the event page.
    const listAnon = await request(app).get(`/api/social/plans/event/${event._id}`).expect(200);
    expect(listAnon.body.data.plans).toHaveLength(1);
    expect(listAnon.body.data.plans[0].visibility).toBe('public');

    // Friend was invited.
    const invites = await request(app).get('/api/social/plans/mine?section=invitations').set(auth(FRIEND)).expect(200);
    expect(invites.body.data.plans).toHaveLength(1);
  });

  it('hides a private plan from non-invited users everywhere, but shows it to the invited friend', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const friend = await makeBuyer(FRIEND, 'Friend', 'friend_one');
    await makeBuyer(OUTSIDER, 'Out', 'out_one');
    const event = await makeEvent();

    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'Private crew', visibility: 'private', inviteeIds: [String(friend._id)] })
      .expect(201);
    const planId = created.body.data.id;

    // Public event listing never shows it.
    const listOutsider = await request(app).get(`/api/social/plans/event/${event._id}`).set(auth(OUTSIDER)).expect(200);
    expect(listOutsider.body.data.plans).toHaveLength(0);

    // But the invited friend sees it on the event page.
    const listFriend = await request(app).get(`/api/social/plans/event/${event._id}`).set(auth(FRIEND)).expect(200);
    expect(listFriend.body.data.plans).toHaveLength(1);

    // An outsider gets 404 on the plan detail and messages — existence isn't leaked.
    await request(app).get(`/api/social/plans/${planId}`).set(auth(OUTSIDER)).expect(404);
    await request(app).get(`/api/social/plans/${planId}/messages`).set(auth(OUTSIDER)).expect(404);

    // The invited friend can open it even before accepting.
    await request(app).get(`/api/social/plans/${planId}`).set(auth(FRIEND)).expect(200);
  });

  it('open public plan: anyone signed in can join immediately', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();
    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'Open plan', visibility: 'public', joinPolicy: 'open' })
      .expect(201);

    const joined = await request(app).post(`/api/social/plans/${created.body.data.id}/join`).set(auth(FRIEND)).expect(200);
    expect(joined.body.data.plan.viewer.memberStatus).toBe('accepted');
    expect(joined.body.data.plan.memberCount).toBe(2);
  });

  it('request-to-join public plan requires admin approval', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const friend = await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();
    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'Curated plan', visibility: 'public', joinPolicy: 'request' })
      .expect(201);
    const planId = created.body.data.id;

    await request(app).post(`/api/social/plans/${planId}/join`).set(auth(FRIEND)).expect(200);
    const afterRequest = await request(app).get(`/api/social/plans/${planId}`).set(auth(FRIEND)).expect(200);
    expect(afterRequest.body.data.plan.viewer.memberStatus).toBe('requested');

    const memberRow = await EventPlanMember.findOne({ planId, buyerId: friend._id });
    await request(app).post(`/api/social/plans/requests/${memberRow!._id}/approve`).set(auth(ADMIN)).expect(200);

    const afterApproval = await request(app).get(`/api/social/plans/${planId}`).set(auth(FRIEND)).expect(200);
    expect(afterApproval.body.data.plan.viewer.memberStatus).toBe('accepted');
  });

  it('invitee can accept or decline an invitation', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const friend = await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();
    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'Invite test', inviteeIds: [String(friend._id)] })
      .expect(201);

    const memberRow = await EventPlanMember.findOne({ planId: created.body.data.id, buyerId: friend._id });
    await request(app).post(`/api/social/plans/invites/${memberRow!._id}/decline`).set(auth(FRIEND)).expect(200);
    expect((await EventPlanMember.findById(memberRow!._id))!.status).toBe('declined');
  });

  it('prevents duplicate invitations/memberships and respects blocks', async () => {
    const admin = await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const friend = await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const blocked = await makeBuyer(OUTSIDER, 'Out', 'out_one');
    await Block.create({ blockerId: admin._id, blockedId: blocked._id });
    const event = await makeEvent();
    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'No dupes', inviteeIds: [String(friend._id)] })
      .expect(201);
    const planId = created.body.data.id;

    // Re-inviting the same (already invited) friend, plus a blocked user, is a no-op skip for both.
    const result = await request(app)
      .post(`/api/social/plans/${planId}/invite`)
      .set(auth(ADMIN))
      .send({ buyerIds: [String(friend._id), String(blocked._id)] })
      .expect(200);
    expect(result.body.data.invited).toEqual([]);
    expect(result.body.data.skipped.sort()).toEqual([String(friend._id), String(blocked._id)].sort());
    expect(await EventPlanMember.countDocuments({ planId })).toBe(2); // admin + friend only
  });

  it('only accepted members may vote attendance; going does not touch tickets', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    await makeBuyer(FRIEND, 'Friend', 'friend_one');
    await makeBuyer(OUTSIDER, 'Out', 'out_one');
    const event = await makeEvent();
    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'Vote test', visibility: 'public', joinPolicy: 'open' })
      .expect(201);
    const planId = created.body.data.id;

    await request(app).post(`/api/social/plans/${planId}/attendance`).set(auth(OUTSIDER)).send({ status: 'going' }).expect(403);

    await request(app).post(`/api/social/plans/${planId}/join`).set(auth(FRIEND)).expect(200);
    await request(app).post(`/api/social/plans/${planId}/attendance`).set(auth(FRIEND)).send({ status: 'going' }).expect(200);

    const detail = await request(app).get(`/api/social/plans/${planId}`).set(auth(FRIEND)).expect(200);
    const friendRow = detail.body.data.plan.members.find((m: any) => m.username === 'friend_one');
    expect(friendRow.attendance).toBe('going');

    // Event ticket count is untouched by attendance voting.
    const reloadedEvent = await Event.findById(event._id);
    expect(reloadedEvent!.ticketTypes[0]!.sold).toBe(0);
  });

  it('changing visibility requires confirmation and removes a public plan from the event page without dropping members', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();
    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'Visibility test', visibility: 'public', joinPolicy: 'open' })
      .expect(201);
    const planId = created.body.data.id;
    await request(app).post(`/api/social/plans/${planId}/join`).set(auth(FRIEND)).expect(200);

    await request(app).patch(`/api/social/plans/${planId}/visibility`).set(auth(ADMIN)).send({ visibility: 'private' }).expect(400);
    await request(app)
      .patch(`/api/social/plans/${planId}/visibility`)
      .set(auth(ADMIN))
      .send({ visibility: 'private', confirmed: true })
      .expect(200);

    const list = await request(app).get(`/api/social/plans/event/${event._id}`).expect(200);
    expect(list.body.data.plans).toHaveLength(0);
    expect(await EventPlanMember.countDocuments({ planId, status: 'accepted' })).toBe(2);
  });

  it('cancelling a plan does not touch the event or its tickets', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const event = await makeEvent();
    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'Cancel me' })
      .expect(201);

    const statusBefore = event.status;
    await request(app).post(`/api/social/plans/${created.body.data.id}/cancel`).set(auth(ADMIN)).expect(200);
    expect((await EventPlan.findById(created.body.data.id))!.status).toBe('cancelled');
    expect((await Event.findById(event._id))!.status).toBe(statusBefore); // event untouched
  });

  it('public plan conversation: anonymous can read, only members can post; reactions work', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();
    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'Chatty plan', visibility: 'public', joinPolicy: 'open' })
      .expect(201);
    const planId = created.body.data.id;

    await request(app)
      .post(`/api/social/plans/${planId}/messages`)
      .set(auth(FRIEND))
      .send({ body: 'hi' })
      .expect(403); // not a member yet

    await request(app).post(`/api/social/plans/${planId}/join`).set(auth(FRIEND)).expect(200);
    const sent = await request(app).post(`/api/social/plans/${planId}/messages`).set(auth(FRIEND)).send({ body: 'hi everyone' }).expect(201);
    const messageId = sent.body.data.message.id;

    const anonRead = await request(app).get(`/api/social/plans/${planId}/messages`).expect(200);
    expect(anonRead.body.data.messages).toHaveLength(1);
    expect(anonRead.body.data.messages[0].body).toBe('hi everyone');

    await request(app).post(`/api/social/plans/${planId}/messages/${messageId}/react`).set(auth(ADMIN)).send({ emoji: '👍' }).expect(200);
    const withReaction = await request(app).get(`/api/social/plans/${planId}/messages`).expect(200);
    expect(withReaction.body.data.messages[0].reactions).toEqual([{ emoji: '👍', count: 1, buyerIds: [String((await Buyer.findOne({ username: 'admin_one' }))!._id)] }]);
  });

  it('admin sees pending invites/requests; a non-admin gets 403', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const friend = await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();
    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'Pending test', visibility: 'public', joinPolicy: 'request', inviteeIds: [String(friend._id)] })
      .expect(201);
    const planId = created.body.data.id;

    const detail = await request(app).get(`/api/social/plans/${planId}`).set(auth(FRIEND)).expect(200);
    expect(detail.body.data.plan.viewer.memberId).toBeTruthy();

    await makeBuyer(OUTSIDER, 'Out', 'out_one');
    await request(app).post(`/api/social/plans/${planId}/join`).set(auth(OUTSIDER)).expect(200); // requested

    const pending = await request(app).get(`/api/social/plans/${planId}/pending`).set(auth(ADMIN)).expect(200);
    expect(pending.body.data.invited).toHaveLength(1);
    expect(pending.body.data.requested).toHaveLength(1);

    await request(app).get(`/api/social/plans/${planId}/pending`).set(auth(FRIEND)).expect(403);
  });

  it('a member who leaves loses access; the admin cannot leave (must cancel)', async () => {
    await makeBuyer(ADMIN, 'Admin', 'admin_one');
    const friend = await makeBuyer(FRIEND, 'Friend', 'friend_one');
    const event = await makeEvent();
    const created = await request(app)
      .post('/api/social/plans')
      .set(auth(ADMIN))
      .send({ eventId: String(event._id), name: 'Leave test', visibility: 'private', inviteeIds: [String(friend._id)] })
      .expect(201);
    const planId = created.body.data.id;
    const memberRow = await EventPlanMember.findOne({ planId, buyerId: friend._id });
    await request(app).post(`/api/social/plans/invites/${memberRow!._id}/accept`).set(auth(FRIEND)).expect(200);

    await request(app).post(`/api/social/plans/${planId}/leave`).set(auth(FRIEND)).expect(200);
    await request(app).get(`/api/social/plans/${planId}`).set(auth(FRIEND)).expect(404);

    await request(app).post(`/api/social/plans/${planId}/leave`).set(auth(ADMIN)).expect(400);
  });
});
