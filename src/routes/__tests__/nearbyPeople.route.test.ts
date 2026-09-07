import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { signBuyerToken } from '../../__tests__/helpers/auth';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { Block } from '@models/block.model';
import { BuyerPresence } from '@models/buyerPresence.model';
import { MeetupRequest } from '@models/meetupRequest.model';

const PHONE = '+26878422613';
// Viewer's search origin. Kept at (0, 0) so north/south offsets in degrees
// translate to a simple great-circle distance for the assertions below.
const ORIGIN_LAT = 0;
const ORIGIN_LNG = 0;
const EARTH_RADIUS_KM = 6378.1; // matches MongoDB's spherical geo assumption

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

describe('GET /api/social/nearby/people', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Buyer.init();
    await Follow.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function seedBuyer(phone: string, extra: Record<string, unknown> = {}) {
    return Buyer.create({ phone, password: 'secret1', name: 'Buyer', ...extra });
  }

  function nearPoint(deltaLatDeg: number) {
    return { type: 'Point' as const, coordinates: [ORIGIN_LNG, ORIGIN_LAT + deltaLatDeg] as [number, number] };
  }

  it('401s when anonymous', async () => {
    await request(app).get('/api/social/nearby/people').query({ lat: 0, lng: 0 }).expect(401);
  });

  it('400s when lat is missing/invalid', async () => {
    await seedBuyer(PHONE, { username: 'me_one' });
    await request(app)
      .get('/api/social/nearby/people')
      .query({ lng: 0 })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(400);
  });

  it('400s when lat/lng are out of range', async () => {
    await seedBuyer(PHONE, { username: 'me_one' });
    await request(app)
      .get('/api/social/nearby/people')
      .query({ lat: 200, lng: 0 })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(400);
  });

  it('returns an empty list, never fake data, when no one is nearby', async () => {
    await seedBuyer(PHONE, { username: 'me_one' });
    const res = await request(app)
      .get('/api/social/nearby/people')
      .query({ lat: ORIGIN_LAT, lng: ORIGIN_LNG })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);
    expect(res.body.data.people).toEqual([]);
  });

  it('surfaces a buyer within radiusKm with distanceKm, online and mutualCount populated', async () => {
    const me = await seedBuyer(PHONE, { username: 'me_one' });
    const deltaLatDeg = 0.05; // ~5.56km north
    const nearby = await seedBuyer('+26878000021', {
      username: 'nearby_a',
      avatarUrl: 'https://cdn.example.com/a.png',
      bio: 'hi there',
      location: nearPoint(deltaLatDeg),
      locationUpdatedAt: new Date(),
    });
    // Presence -> online
    await BuyerPresence.create({
      buyerId: nearby._id,
      socketId: 'socket-nearby',
      instanceId: 'instance-1',
      lastSeenAt: new Date(),
    });
    // Shared follow -> mutualCount 1
    const mutual = await seedBuyer('+26878000099', { username: 'mutual_c' });
    await Follow.create({ followerType: 'buyer', followerId: me._id, targetType: 'buyer', targetId: mutual._id });
    await Follow.create({ followerType: 'buyer', followerId: nearby._id, targetType: 'buyer', targetId: mutual._id });

    const res = await request(app)
      .get('/api/social/nearby/people')
      .query({ lat: ORIGIN_LAT, lng: ORIGIN_LNG })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    const row = res.body.data.people.find((p: any) => p.username === 'nearby_a');
    expect(row).toBeTruthy();
    const expectedKm = Math.round(haversineKm(ORIGIN_LAT, ORIGIN_LNG, ORIGIN_LAT + deltaLatDeg, ORIGIN_LNG) * 10) / 10;
    expect(row).toEqual({
      id: String(nearby._id),
      name: 'Buyer',
      username: 'nearby_a',
      avatarUrl: 'https://cdn.example.com/a.png',
      bio: 'hi there',
      city: null,
      distanceKm: expectedKm,
      online: true,
      mutualCount: 1,
      currentEvent: null,
      meetupStatus: 'none',
      meetupRequestId: null,
      canDm: true,
    });
  });

  it('nearby people include canDm — true for both a connected partner and a stranger (only blocks disable it)', async () => {
    const me = await seedBuyer(PHONE, { username: 'me_one' });
    const partner = await seedBuyer('+26878000028', {
      username: 'partner_g',
      location: nearPoint(0.01),
      locationUpdatedAt: new Date(),
    });
    const stranger = await seedBuyer('+26878000029', {
      username: 'stranger_h',
      location: nearPoint(0.02),
      locationUpdatedAt: new Date(),
    });
    await MeetupRequest.create({ requesterId: me._id, targetId: partner._id, status: 'accepted' });

    const res = await request(app)
      .get('/api/social/nearby/people')
      .query({ lat: ORIGIN_LAT, lng: ORIGIN_LNG })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    const partnerRow = res.body.data.people.find((p: any) => p.username === 'partner_g');
    const strangerRow = res.body.data.people.find((p: any) => p.username === 'stranger_h');
    expect(partnerRow).toBeTruthy();
    expect(strangerRow).toBeTruthy();
    expect(partnerRow.canDm).toBe(true);
    expect(strangerRow.canDm).toBe(true);
  });

  it('excludes a buyer outside radiusKm', async () => {
    await seedBuyer(PHONE, { username: 'me_one' });
    await seedBuyer('+26878000022', {
      username: 'far_b',
      location: nearPoint(0.5), // ~55.6km away
      locationUpdatedAt: new Date(),
    });

    const res = await request(app)
      .get('/api/social/nearby/people')
      .query({ lat: ORIGIN_LAT, lng: ORIGIN_LNG, radiusKm: 5 })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    const usernames = res.body.data.people.map((p: any) => p.username);
    expect(usernames).not.toContain('far_b');
  });

  it('excludes a buyer blocked in either direction', async () => {
    const me = await seedBuyer(PHONE, { username: 'me_one' });
    const blockedByMe = await seedBuyer('+26878000023', {
      username: 'blocked_c',
      location: nearPoint(0.01),
      locationUpdatedAt: new Date(),
    });
    const blockedMe = await seedBuyer('+26878000024', {
      username: 'blocker_d',
      location: nearPoint(0.02),
      locationUpdatedAt: new Date(),
    });
    await Block.create({ blockerId: me._id, blockedId: blockedByMe._id });
    await Block.create({ blockerId: blockedMe._id, blockedId: me._id });

    const res = await request(app)
      .get('/api/social/nearby/people')
      .query({ lat: ORIGIN_LAT, lng: ORIGIN_LNG })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    const usernames = res.body.data.people.map((p: any) => p.username);
    expect(usernames).not.toContain('blocked_c');
    expect(usernames).not.toContain('blocker_d');
  });

  it('excludes self even when the viewer has opted into location sharing at the same point', async () => {
    await seedBuyer(PHONE, {
      username: 'me_one',
      location: nearPoint(0),
      locationUpdatedAt: new Date(),
    });

    const res = await request(app)
      .get('/api/social/nearby/people')
      .query({ lat: ORIGIN_LAT, lng: ORIGIN_LNG })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    const usernames = res.body.data.people.map((p: any) => p.username);
    expect(usernames).not.toContain('me_one');
  });

  it('excludes a buyer who never opted into location sharing', async () => {
    await seedBuyer(PHONE, { username: 'me_one' });
    await seedBuyer('+26878000025', { username: 'no_location_e' }); // no `location` field at all

    const res = await request(app)
      .get('/api/social/nearby/people')
      .query({ lat: ORIGIN_LAT, lng: ORIGIN_LNG, radiusKm: 200 })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    const usernames = res.body.data.people.map((p: any) => p.username);
    expect(usernames).not.toContain('no_location_e');
  });

  it('excludes a nearby buyer with no username', async () => {
    await seedBuyer(PHONE, { username: 'me_one' });
    await seedBuyer('+26878000026', {
      location: nearPoint(0.01),
      locationUpdatedAt: new Date(),
    }); // no username set

    const res = await request(app)
      .get('/api/social/nearby/people')
      .query({ lat: ORIGIN_LAT, lng: ORIGIN_LNG })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    expect(res.body.data.people).toEqual([]);
  });

  it('excludes a nearby buyer who is socially suspended', async () => {
    await seedBuyer(PHONE, { username: 'me_one' });
    await seedBuyer('+26878000027', {
      username: 'suspended_f',
      location: nearPoint(0.01),
      locationUpdatedAt: new Date(),
      socialSuspendedAt: new Date(),
    });

    const res = await request(app)
      .get('/api/social/nearby/people')
      .query({ lat: ORIGIN_LAT, lng: ORIGIN_LNG })
      .set('Authorization', `Bearer ${signBuyerToken(PHONE)}`)
      .expect(200);

    const usernames = res.body.data.people.map((p: any) => p.username);
    expect(usernames).not.toContain('suspended_f');
  });
});
