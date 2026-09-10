import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signVendorToken, signBuyerToken } from '../../__tests__/helpers/auth';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { AccountActivityService } from '@services/accountActivity.service';

let vseq = 0;
const makeVendor = (name?: string) => {
  vseq += 1;
  return Vendor.create({
    businessName: name ?? `Brand ${vseq}`,
    email: `vendor${vseq}@example.com`,
    phoneNumber: `+2687${8000000 + vseq}`,
    password: 'secret123',
  });
};

/**
 * Regression coverage for the client report "when logged in as organizer
 * there is an error under My Account" — the frontend was calling this exact
 * endpoint with a vendor token, and it 404'd/401'd because only the buyer
 * route existed (@routes/social.route). AccountActivityService itself was
 * always owner-agnostic; only the route+controller pair was missing.
 */
describe('/api/tickets/social/me/account-activity (vendor)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('lists the organizer brand\'s own account-activity feed', async () => {
    const vendor = await makeVendor('Bhora Fest');
    const actor = await Buyer.create({ phone: '+26878030201', password: 'secret1', name: 'Fan' });
    await AccountActivityService.record({
      ownerId: String(vendor._id), actorType: 'buyer', actorId: String(actor._id), kind: 'profile_view',
    });

    const res = await request(app).get('/api/tickets/social/me/account-activity')
      .set('Authorization', `Bearer ${signVendorToken(String(vendor._id))}`).expect(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ kind: 'profile_view', count: 1, unread: true });
    expect(res.body.data.unreadCount).toBe(1);
  });

  it('marks one group read, then all read', async () => {
    const vendor = await makeVendor();
    const actor = await Buyer.create({ phone: '+26878030202', password: 'secret1', name: 'Fan2' });
    await AccountActivityService.record({
      ownerId: String(vendor._id), actorType: 'buyer', actorId: String(actor._id), kind: 'profile_view',
    });
    const token = `Bearer ${signVendorToken(String(vendor._id))}`;

    await request(app).post('/api/tickets/social/me/account-activity/read')
      .set('Authorization', token)
      .send({ actorType: 'buyer', actorId: String(actor._id), kind: 'profile_view' })
      .expect(200);
    const afterRead = await request(app).get('/api/tickets/social/me/account-activity').set('Authorization', token).expect(200);
    expect(afterRead.body.data.unreadCount).toBe(0);

    await AccountActivityService.record({
      ownerId: String(vendor._id), actorType: 'buyer', actorId: String(actor._id), kind: 'unfollow',
    });
    await request(app).post('/api/tickets/social/me/account-activity/read-all').set('Authorization', token).expect(200);
    const afterReadAll = await request(app).get('/api/tickets/social/me/account-activity').set('Authorization', token).expect(200);
    expect(afterReadAll.body.data.unreadCount).toBe(0);
  });

  it('401s a buyer token (no vendorId)', async () => {
    await request(app).get('/api/tickets/social/me/account-activity')
      .set('Authorization', `Bearer ${signBuyerToken('+26878422613')}`).expect(401);
  });
});
