import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedPublishedEvent } from '../../__tests__/helpers/fixtures';
import { Vendor } from '@models/vendor.model';
import { Event } from '@models/event.model';
import { Buyer } from '@models/buyer.model';
import { FollowService } from '@services/follow.service';
import { EventStatus } from '@interfaces/event.interface';

describe('organizer public profile', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('assembles brand card, follower count, rating and event lists — publicly', async () => {
    const vendor = await Vendor.create({
      businessName: 'Piano Republic Events', email: 'org@example.com', password: 'secret123',
      phoneNumber: '+26878000099', logoUrl: 'https://cdn.example.com/logo.png', bio: 'Best shows.',
    });

    // one upcoming + one past event owned by this vendor
    const upcoming = await seedPublishedEvent({ vendorId: vendor._id as any });
    const past = await seedPublishedEvent({ vendorId: vendor._id as any });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await Event.updateOne({ _id: past.eventId }, { eventDate: yesterday, startTime: yesterday, endTime: yesterday });

    const follower = await Buyer.create({ phone: '+26878422613', password: 'secret1' });
    await FollowService.follow(follower, 'organizer', String(vendor._id));

    // This brand also FOLLOWS one other brand (actor = vendor), so
    // followingCount is a distinct axis from followerCount above.
    const otherBrand = await Vendor.create({
      businessName: 'Another Org', email: 'other@example.com', password: 'secret123',
      phoneNumber: '+26878000097',
    });
    await FollowService.followAsVendor(String(vendor._id), 'organizer', String(otherBrand._id));

    const res = await request(app).get(`/api/public/organizers/${String(vendor._id)}`).expect(200);
    const p = res.body.data;
    expect(p.businessName).toBe('Piano Republic Events');
    expect(p.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(p.followerCount).toBe(1);
    expect(p.followingCount).toBe(1);
    expect(p.eventCount).toBe(2);
    expect(p.rating).toEqual({ average: null, count: 0 });
    expect(p.upcomingEvents.map((e: any) => e.id)).toEqual([upcoming.eventId]);
    expect(p.pastEvents.map((e: any) => e.id)).toEqual([past.eventId]);
    expect(JSON.stringify(p)).not.toContain('org@example.com');
    expect(JSON.stringify(p)).not.toContain('+26878000099');
  });

  it('eventCount excludes drafts, pending approval and cancelled events, includes completed', async () => {
    const vendor = await Vendor.create({
      businessName: 'Draft Heavy Events', email: 'drafty@example.com', password: 'secret123',
      phoneNumber: '+26878000096',
    });

    await seedPublishedEvent({ vendorId: vendor._id as any });
    const completed = await seedPublishedEvent({ vendorId: vendor._id as any });
    await Event.updateOne({ _id: completed.eventId }, { status: EventStatus.COMPLETED });
    const cancelled = await seedPublishedEvent({ vendorId: vendor._id as any });
    await Event.updateOne({ _id: cancelled.eventId }, { status: EventStatus.CANCELLED });
    const draft = await seedPublishedEvent({ vendorId: vendor._id as any });
    await Event.updateOne({ _id: draft.eventId }, { status: EventStatus.DRAFT });
    const pending = await seedPublishedEvent({ vendorId: vendor._id as any });
    await Event.updateOne({ _id: pending.eventId }, { status: EventStatus.PENDING_APPROVAL });

    const res = await request(app).get(`/api/public/organizers/${String(vendor._id)}`).expect(200);
    expect(res.body.data.eventCount).toBe(2);
  });

  it('404 for unknown and for inactive vendors; 400 for bad id', async () => {
    await request(app).get('/api/public/organizers/aaaaaaaaaaaaaaaaaaaaaaaa').expect(404);
    await request(app).get('/api/public/organizers/nope').expect(400);

    const inactive = await Vendor.create({
      businessName: 'Gone Events', email: 'gone@example.com', password: 'secret123',
      phoneNumber: '+26878000098', isActive: false,
    });
    await request(app).get(`/api/public/organizers/${String(inactive._id)}`).expect(404);
  });
});
