import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Buyer, IBuyer } from '@models/buyer.model';
import { BlockService } from '@services/block.service';
import { DmEligibilityService } from '@services/dmEligibility.service';

const seed = (phone: string) => Buyer.create({ phone, password: 'secret1', name: `B${phone.slice(-4)}` });

describe('DmEligibilityService', () => {
  beforeAll(async () => {
    await connectTestDb();
  });
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('a stranger IS eligible — no follow/meetup connection required', async () => {
    const a = await seed('+26878020001');
    const b = await seed('+26878020002');
    expect(await DmEligibilityService.canDm(String(a._id), String(b._id))).toBe(true);
  });
  it('a block beats everything, both directions', async () => {
    const a = await seed('+26878020007');
    const b = await seed('+26878020008');
    await BlockService.block(a, String(b._id));
    expect(await DmEligibilityService.canDm(String(a._id), String(b._id))).toBe(false);
    expect(await DmEligibilityService.canDm(String(b._id), String(a._id))).toBe(false);
  });
  it('canDmMap returns everyone except blocked ids', async () => {
    const me = await seed('+26878020009');
    const stranger = await seed('+26878020012');
    const blocked = await seed('+26878020013');
    await BlockService.block(me, String(blocked._id));
    const ids = [stranger, blocked].map((b: IBuyer) => String(b._id));
    const set = await DmEligibilityService.canDmMap(String(me._id), ids);
    expect(set.has(String(stranger._id))).toBe(true);
    expect(set.has(String(blocked._id))).toBe(false);
  });
});
