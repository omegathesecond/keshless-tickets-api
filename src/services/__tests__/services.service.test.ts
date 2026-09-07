import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ServicesService } from '@services/services.service';
import { FollowService } from '@services/follow.service';
import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function mkBiz(over: any = {}) {
  return Vendor.create({
    businessName: over.businessName ?? 'Luxe Decor', phoneNumber: over.phoneNumber ?? '+2687650' + Math.floor(Math.random()*100000),
    password: 'secret1', operatorType: OperatorType.SERVICES, serviceCategory: over.serviceCategory ?? 'furniture_decor',
    verificationStatus: over.verificationStatus ?? VerificationStatus.VERIFIED, bio: over.bio ?? 'Elegant furniture & styling',
    address: over.address, startingPrice: over.startingPrice, isActive: over.isActive,
  });
}

describe('ServicesService.listDirectory', () => {
  // Verification is a TRUST BADGE, not a visibility gate: a business that has
  // just signed up (PENDING) is listed and reachable immediately, it simply
  // carries no verified sign until an admin flips it.
  it('lists pending businesses alongside verified ones', async () => {
    await mkBiz({ businessName: 'Verified Co' });
    await mkBiz({ businessName: 'Pending Co', verificationStatus: VerificationStatus.PENDING });
    const names = (await ServicesService.listDirectory({})).map((c) => c.businessName);
    expect(names).toContain('Verified Co');
    expect(names).toContain('Pending Co');
  });

  // ...but admin takedown still has to work, so the two "no" statuses and the
  // isActive kill-switch stay hidden.
  it('hides rejected, suspended and deactivated businesses', async () => {
    await mkBiz({ businessName: 'Rejected Co', verificationStatus: VerificationStatus.REJECTED });
    await mkBiz({ businessName: 'Suspended Co', verificationStatus: VerificationStatus.SUSPENDED });
    await mkBiz({ businessName: 'Deactivated Co', isActive: false });
    await mkBiz({ businessName: 'Live Co' });
    expect((await ServicesService.listDirectory({})).map((c) => c.businessName)).toEqual(['Live Co']);
  });

  it('hides vendors from other verticals', async () => {
    await mkBiz({ businessName: 'Verified Co' });
    await Vendor.create({ businessName: 'Event Org', phoneNumber: '+26876999001', password: 'secret1', operatorType: OperatorType.EVENTS, verificationStatus: VerificationStatus.VERIFIED });
    expect((await ServicesService.listDirectory({})).map((c) => c.businessName)).toEqual(['Verified Co']);
  });

  it('marks each card with its own badge state', async () => {
    await mkBiz({ businessName: 'Verified Co' });
    await mkBiz({ businessName: 'Pending Co', verificationStatus: VerificationStatus.PENDING });
    const byName = Object.fromEntries((await ServicesService.listDirectory({})).map((c) => [c.businessName, c.verified]));
    expect(byName['Verified Co']).toBe(true);
    expect(byName['Pending Co']).toBe(false);
  });

  it('filters by category and searches by name', async () => {
    await mkBiz({ businessName: 'SoundWave', serviceCategory: 'sound_hire' });
    await mkBiz({ businessName: 'FoodFest', serviceCategory: 'food_stalls' });
    expect((await ServicesService.listDirectory({ category: 'sound_hire' })).map((c) => c.businessName)).toEqual(['SoundWave']);
    expect((await ServicesService.listDirectory({ search: 'food' })).map((c) => c.businessName)).toEqual(['FoodFest']);
  });

  it('does not throw on a regex-metacharacter search term, and matches it literally', async () => {
    await mkBiz({ businessName: 'A(B) Events' });
    const cards = await ServicesService.listDirectory({ search: 'a(' });
    expect(cards.map((c) => c.businessName)).toEqual(['A(B) Events']);
  });
});

describe('ServicesService.getBusinessProfile', () => {
  it('returns the profile for a verified services vendor', async () => {
    const v = await mkBiz({ startingPrice: { amountCents: 18000, unit: 'day' }, address: { city: 'Manzini', region: 'Manzini' } });
    const p = await ServicesService.getBusinessProfile(String(v._id));
    expect(p.businessName).toBe('Luxe Decor');
    expect(p.serviceCategory).toBe('furniture_decor');
    expect(p.startingPrice?.amountCents).toBe(18000);
    expect(p.city).toBe('Manzini');
    expect(p.verified).toBe(true);
  });

  // The bug this fixes: a business signed up, was redirected to its own
  // profile, and got "Business not found" because it was still PENDING.
  it('returns a pending business, unbadged, instead of 404ing it', async () => {
    const v = await mkBiz({ businessName: 'Fresh Signup', verificationStatus: VerificationStatus.PENDING });
    const p = await ServicesService.getBusinessProfile(String(v._id));
    expect(p.businessName).toBe('Fresh Signup');
    expect(p.verified).toBe(false);
  });

  it('404s for a rejected business', async () => {
    const v = await mkBiz({ verificationStatus: VerificationStatus.REJECTED });
    await expect(ServicesService.getBusinessProfile(String(v._id))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('404s for a suspended business', async () => {
    const v = await mkBiz({ verificationStatus: VerificationStatus.SUSPENDED });
    await expect(ServicesService.getBusinessProfile(String(v._id))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('404s for a deactivated business', async () => {
    const v = await mkBiz({ isActive: false });
    await expect(ServicesService.getBusinessProfile(String(v._id))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('404s for an events vendor', async () => {
    const v = await Vendor.create({ businessName: 'Org', phoneNumber: '+26876999002', password: 'secret1', operatorType: OperatorType.EVENTS, verificationStatus: VerificationStatus.VERIFIED });
    await expect(ServicesService.getBusinessProfile(String(v._id))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reports followingCount as a distinct axis from followerCount', async () => {
    const v = await mkBiz();
    const other = await mkBiz({ businessName: 'Other Co' });
    await FollowService.followAsVendor(String(v._id), 'organizer', String(other._id));
    const p = await ServicesService.getBusinessProfile(String(v._id));
    expect(p.followingCount).toBe(1);
    expect(p.followerCount).toBe(0);
  });
});
