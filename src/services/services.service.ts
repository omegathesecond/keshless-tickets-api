import { Vendor } from '@models/vendor.model';
import { OperatorType, VerificationStatus } from '@interfaces/vendor.interface';
import { ReviewService } from '@services/review.service';
import { FollowService } from '@services/follow.service';
import { HttpError } from '@utils/httpError.util';
import { VISIBLE_BUSINESS_FILTER } from '@utils/businessVisibility.util';

const HEX24 = /^[a-f0-9]{24}$/i;

const tagline = (bio?: string) => (bio ? (bio.length > 120 ? bio.slice(0, 117) + '…' : bio) : null);

export interface ServiceCard {
  id: string; businessName: string; slug: string | null; logoUrl: string | null;
  serviceCategory: string; city: string | null;
  rating: { average: number | null; count: number };
  startingPrice: { amountCents: number; unit: string } | null; tagline: string | null;
  verified: boolean;
}

export interface BusinessProfile {
  id: string; businessName: string; slug: string | null; logoUrl: string | null;
  serviceCategory: string; city: string | null; region: string | null; bio: string | null;
  rating: { average: number | null; count: number }; followerCount: number; followingCount: number;
  startingPrice: { amountCents: number; unit: string } | null;
  contact: { email: string | null; phone: string | null };
  verified: boolean;
}

export class ServicesService {
  static async listDirectory(opts: { category?: string; search?: string; before?: string; limit?: number } = {}): Promise<ServiceCard[]> {
    const limit = Math.min(Math.max(opts.limit ?? 24, 1), 50);
    const query: Record<string, unknown> = { ...VISIBLE_BUSINESS_FILTER };
    if (opts.category) query['serviceCategory'] = opts.category;
    if (opts.search) query['businessName'] = { $regex: opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (opts.before && HEX24.test(opts.before)) query['_id'] = { $lt: opts.before };

    const docs = await Vendor.find(query)
      .select('businessName slug logoUrl serviceCategory address bio startingPrice verificationStatus')
      .sort({ _id: -1 }).limit(limit);

    // Rating aggregate per vendor (small page, so N small aggregates is fine).
    return Promise.all(docs.map(async (v): Promise<ServiceCard> => ({
      id: String(v._id), businessName: v.businessName, slug: (v as any).slug ?? null,
      logoUrl: v.logoUrl ?? null, serviceCategory: (v as any).serviceCategory,
      city: v.address?.city ?? null, rating: await ReviewService.vendorAggregate(String(v._id)),
      startingPrice: (v as any).startingPrice ?? null, tagline: tagline(v.bio),
      verified: v.verificationStatus === VerificationStatus.VERIFIED,
    })));
  }

  static async getBusinessProfile(businessId: string): Promise<BusinessProfile> {
    if (!HEX24.test(businessId)) throw new HttpError(400, 'Invalid business id');
    const v = await Vendor.findOne({ _id: businessId, ...VISIBLE_BUSINESS_FILTER })
      .select('businessName slug logoUrl serviceCategory address bio startingPrice email phoneNumber verificationStatus');
    if (!v) throw new HttpError(404, 'Business not found');
    const [rating, followerCount, followingCount] = await Promise.all([
      ReviewService.vendorAggregate(businessId),
      FollowService.followerCount('organizer', businessId),
      FollowService.followingCount(businessId, 'vendor'),
    ]);
    return {
      id: String(v._id), businessName: v.businessName, slug: (v as any).slug ?? null,
      logoUrl: v.logoUrl ?? null, serviceCategory: (v as any).serviceCategory,
      city: v.address?.city ?? null, region: v.address?.region ?? null, bio: v.bio ?? null,
      rating, followerCount, followingCount, startingPrice: (v as any).startingPrice ?? null,
      contact: { email: (v as any).email ?? null, phone: (v as any).phoneNumber ?? null },
      verified: v.verificationStatus === VerificationStatus.VERIFIED,
    };
  }
}
