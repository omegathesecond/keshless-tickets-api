import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { MeetupRequest } from '@models/meetupRequest.model';
import { SocialProfileViewService } from '@services/socialProfileView.service';

const seed = (phone: string, username: string) =>
  Buyer.create({ phone, password: 'secret1', name: username, username });

describe('SocialProfileViewService canDm/meetup fields', () => {
  beforeAll(async () => {
    await connectTestDb();
    await Follow.init();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('buyer viewer: stranger => canDm true (no connection required), meetupStatus none', async () => {
    const viewer = await seed('+26878030001', 'viewer_a');
    await seed('+26878030002', 'target_a');
    const p = await SocialProfileViewService.forViewer('target_a', { type: 'buyer', id: String(viewer._id) });
    expect(p!.canDm).toBe(true);
    expect(p!.meetupStatus).toBe('none');
    expect(p!.meetupRequestId).toBeNull();
  });

  it('buyer viewer: accepted meetup => canDm true and reflects outgoing status', async () => {
    const viewer = await seed('+26878030003', 'viewer_b');
    const target = await seed('+26878030004', 'target_b');
    const row = await MeetupRequest.create({ requesterId: viewer._id, targetId: target._id, status: 'accepted' });
    const p = await SocialProfileViewService.forViewer('target_b', { type: 'buyer', id: String(viewer._id) });
    expect(p!.canDm).toBe(true);
    expect(p!.meetupStatus).toBe('accepted');
    expect(p!.meetupRequestId).toBe(String(row._id));
  });

  it('buyer viewer: pending outgoing => canDm still true, status pending', async () => {
    const viewer = await seed('+26878030005', 'viewer_c');
    const target = await seed('+26878030006', 'target_c');
    await MeetupRequest.create({ requesterId: viewer._id, targetId: target._id, status: 'pending' });
    const p = await SocialProfileViewService.forViewer('target_c', { type: 'buyer', id: String(viewer._id) });
    expect(p!.canDm).toBe(true);
    expect(p!.meetupStatus).toBe('pending');
  });

  it('vendor viewer: canDm true when not blocked, meetupStatus none', async () => {
    await seed('+26878030007', 'target_d');
    const p = await SocialProfileViewService.forViewer('target_d', { type: 'vendor', id: '507f1f77bcf86cd799439011' });
    expect(p!.canDm).toBe(true);
    expect(p!.meetupStatus).toBe('none');
  });
});
