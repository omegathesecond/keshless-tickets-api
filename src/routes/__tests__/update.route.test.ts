import request from 'supertest';
import mongoose from 'mongoose';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken, signSuperAdminToken, signVendorToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Update } from '@models/update.model';

jest.mock('@utils/updatesR2', () => ({
  updatesR2: {
    rawKey: (ext: string) => `updates/raw/1-abc.${ext}`,
    presignPut: jest.fn().mockResolvedValue('https://r2.example/put?sig=1'),
    publicUrl: (k: string) => `https://cdn.carrottickets.com/${k}`,
  },
}));
jest.mock('@services/transcode.client', () => ({ triggerTranscode: jest.fn().mockResolvedValue(undefined), reconcileStuckUpdates: jest.fn() }));

const PHONE = '+26878422613';

describe('POST /api/public/updates', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('creates a processing video update and returns a presigned upload url', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
    const res = await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'video', caption: 'my clip', items: [{ ext: 'mp4', contentType: 'video/mp4' }] })
      .expect(201);
    expect(res.body.data.uploads).toHaveLength(1);
    expect(res.body.data.uploads[0].uploadUrl).toContain('https://r2.example/put');
    expect(res.body.data.updateId).toBeTruthy();
  });

  it('rejects a mismatched kind/contentType', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg' });
    await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'video', caption: '', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
      .expect(400);
  });

  it('401s without a token', async () => {
    await request(app).post('/api/public/updates').send({ kind: 'image', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] }).expect(401);
  });

  it('201s with one upload per item for a 3-photo post', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
    const res = await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'image', caption: 'trip', items: Array(3).fill({ ext: 'jpg', contentType: 'image/jpeg' }) });
    expect(res.status).toBe(201);
    expect(res.body.data.uploads).toHaveLength(3);
  });

  it('400s a 6-photo post', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
    const res = await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'image', items: Array(6).fill({ ext: 'jpg', contentType: 'image/jpeg' }) });
    expect(res.status).toBe(400);
  });

  it('creates a weekend_recap post with a location, defaulting other posts to category general', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
    const res = await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'image', caption: 'weekend!', category: 'weekend_recap', location: 'Manzini', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
      .expect(201);
    const saved = await Update.findById(res.body.data.updateId);
    expect(saved?.category).toBe('weekend_recap');
    expect(saved?.location).toBe('Manzini');
  });

  it('defaults category to general when omitted', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
    const res = await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'image', caption: 'regular post', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
      .expect(201);
    const saved = await Update.findById(res.body.data.updateId);
    expect(saved?.category).toBe('general');
    expect(saved?.location).toBeNull();
  });

  it('400s an invalid category', async () => {
    await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Poster' });
    await request(app)
      .post('/api/public/updates')
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ kind: 'image', category: 'not-a-real-category', items: [{ ext: 'jpg', contentType: 'image/jpeg' }] })
      .expect(400);
  });
});

describe('POST /api/public/updates/:id/view', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('increments and returns viewCount with no auth required', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await Update.create({
      authorType: 'buyer',
      authorId: author._id,
      kind: 'image',
      caption: 'x',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });

    const res = await request(app)
      .post(`/api/public/updates/${update.id}/view`)
      .expect(200);
    expect(res.body.data.viewCount).toBe(1);
  });
});

describe('DELETE /api/public/updates/:id', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const seedUpdate = async (authorId: string) =>
    Update.create({
      authorType: 'buyer',
      authorId,
      kind: 'image',
      caption: 'x',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });

  const seedVendorUpdate = async (vendorId: string) =>
    Update.create({
      authorType: 'vendor',
      authorId: vendorId,
      kind: 'image',
      caption: 'brand post',
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });

  // THE REPORTED GAP: remove() resolved only a buyer, so an organizer got 403
  // on their own brand post.
  it('allows a vendor to delete their own brand post', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    const update = await seedVendorUpdate(String(vendorId));

    const res = await request(app)
      .delete(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signVendorToken(String(vendorId))}`)
      .expect(200);
    expect(res.body.data.ok).toBe(true);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.status).toBe('removed');
  });

  it("forbids a vendor from deleting a DIFFERENT brand's post", async () => {
    const author = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const update = await seedVendorUpdate(String(author));

    await request(app)
      .delete(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signVendorToken(String(other))}`)
      .expect(403);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.status).not.toBe('removed');
  });

  // (Anonymous delete is already covered below by "denies an anonymous request
  // (no Authorization header)" — the assertion that makes the optionalTicketsAuth
  // mounting safe. Not duplicated here.)

  // The latent hole: the old check compared authorId to buyer._id WITHOUT
  // checking authorType, so a buyer whose _id equalled a vendor's id could
  // delete that brand's post. Construct exactly that collision.
  it('forbids a buyer from deleting a VENDOR post whose authorId equals the buyer _id', async () => {
    const buyer = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Collider' });
    // Same raw id, but authored by a *vendor* — only the authorType check saves us.
    const update = await seedVendorUpdate(String(buyer._id));

    await request(app)
      .delete(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(403);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.status).not.toBe('removed');
  });

  it('allows the author (buyer who created it) to delete their own update', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await seedUpdate(String(author._id));

    const res = await request(app)
      .delete(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);
    expect(res.body.data.ok).toBe(true);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.status).toBe('removed');
  });

  it('allows a super-admin to delete an update they did not author', async () => {
    const OTHER_PHONE = '+26876000001';
    const author = await Buyer.create({ phone: OTHER_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Someone Else' });
    const update = await seedUpdate(String(author._id));

    const res = await request(app)
      .delete(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signSuperAdminToken()}`)
      .expect(200);
    expect(res.body.data.ok).toBe(true);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.status).toBe('removed');
  });

  it('forbids a different buyer (non-author, non-admin) from deleting', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const NON_AUTHOR_PHONE = '+26876000002';
    await Buyer.create({ phone: NON_AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Rando' });
    const update = await seedUpdate(String(author._id));

    await request(app)
      .delete(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(NON_AUTHOR_PHONE)}`)
      .expect(403);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.status).toBe('active');
  });

  it('denies an anonymous request (no Authorization header)', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await seedUpdate(String(author._id));

    await request(app)
      .delete(`/api/public/updates/${update.id}`)
      .expect(403);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.status).toBe('active');
  });
});

describe('PATCH /api/public/updates/:id (edit caption)', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  const seedUpdate = async (authorId: string, caption = 'original caption') =>
    Update.create({
      authorType: 'buyer',
      authorId,
      kind: 'image',
      caption,
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });

  const seedVendorUpdate = async (vendorId: string, caption = 'brand post') =>
    Update.create({
      authorType: 'vendor',
      authorId: vendorId,
      kind: 'image',
      caption,
      media: [{ rawKey: 'k', status: 'ready', image: { url: 'u', width: 1, height: 1 } }],
    });

  it('allows the author to edit their own caption, stamping editedAt and re-deriving hashtags', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await seedUpdate(String(author._id));
    const originalCreatedAt = update.createdAt;

    const res = await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ caption: 'updated caption #music' })
      .expect(200);

    expect(res.body.data.caption).toBe('updated caption #music');
    expect(res.body.data.editedAt).toBeTruthy();

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.caption).toBe('updated caption #music');
    expect(reloaded?.hashtags).toEqual(['music']);
    expect(reloaded?.editedAt).toBeTruthy();
    // Original publish date and feed position are untouched by an edit.
    expect(reloaded?.createdAt.toISOString()).toBe(originalCreatedAt.toISOString());
  });

  it('allows clearing the caption entirely', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await seedUpdate(String(author._id));

    await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ caption: '' })
      .expect(200);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.caption).toBe('');
    expect(reloaded?.hashtags).toEqual([]);
  });

  it('allows a vendor to edit their own brand post caption', async () => {
    const vendorId = new mongoose.Types.ObjectId();
    const update = await seedVendorUpdate(String(vendorId));

    const res = await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signVendorToken(String(vendorId))}`)
      .send({ caption: 'new brand caption' })
      .expect(200);
    expect(res.body.data.caption).toBe('new brand caption');
  });

  it('allows a super-admin to edit a caption they did not author', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await seedUpdate(String(author._id));

    await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signSuperAdminToken()}`)
      .send({ caption: 'moderated caption' })
      .expect(200);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.caption).toBe('moderated caption');
  });

  it('forbids a different buyer (non-author, non-admin) from editing', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const NON_AUTHOR_PHONE = '+26876000002';
    await Buyer.create({ phone: NON_AUTHOR_PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Rando' });
    const update = await seedUpdate(String(author._id));

    await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(NON_AUTHOR_PHONE)}`)
      .send({ caption: 'hijacked' })
      .expect(403);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.caption).toBe('original caption');
  });

  it("forbids a vendor from editing a DIFFERENT brand's post", async () => {
    const author = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    const update = await seedVendorUpdate(String(author));

    await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signVendorToken(String(other))}`)
      .send({ caption: 'hijacked' })
      .expect(403);
  });

  it('denies an anonymous request (no Authorization header)', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await seedUpdate(String(author._id));

    await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .send({ caption: 'hijacked' })
      .expect(403);

    const reloaded = await Update.findById(update.id);
    expect(reloaded?.caption).toBe('original caption');
  });

  it('400s a caption over the 500-char limit — the same limit create() enforces', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await seedUpdate(String(author._id));

    await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ caption: 'x'.repeat(501) })
      .expect(400);
  });

  it('400s a missing caption field', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await seedUpdate(String(author._id));

    await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({})
      .expect(400);
  });

  it('404s a removed post', async () => {
    const author = await Buyer.create({ phone: PHONE, password: 'secret1', avatarUrl: 'https://cdn.carrottickets.com/test/avatar.jpg', name: 'Author' });
    const update = await seedUpdate(String(author._id));
    update.status = 'removed';
    await update.save();

    await request(app)
      .patch(`/api/public/updates/${update.id}`)
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .send({ caption: 'x' })
      .expect(404);
  });
});
