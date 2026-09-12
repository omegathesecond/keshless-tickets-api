import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError, HEX24 } from '@utils/controllerHelpers.util';
import { Vendor } from '@models/vendor.model';
import { organizerProfileSchema } from '@validators/community.validator';
import { FollowService } from '@services/follow.service';
import { ReviewService } from '@services/review.service';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { R2Service } from '@utils/r2.service';
import { notEndedFilter, endedFilter } from '@utils/eventVisibility.util';

export class OrganizerProfileController {
  /** PATCH /api/tickets/organizer/profile — vendor updates its own brand card. */
  static async updateOwn(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = (req as any).ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const { error, value } = organizerProfileSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const vendor = await Vendor.findById(vendorId);
      if (!vendor) return ApiResponseUtil.error(res, 'Organizer not found', 404);
      if (value.logoUrl !== undefined) vendor.logoUrl = value.logoUrl;
      if (value.bio !== undefined) vendor.bio = value.bio;
      await vendor.save();

      return ApiResponseUtil.success(res, {
        id: String(vendor._id),
        businessName: vendor.businessName,
        slug: (vendor as any).slug ?? null,
        logoUrl: vendor.logoUrl ?? null,
        bio: vendor.bio ?? null,
      }, 'Profile updated');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to update organizer profile');
    }
  }

  /** POST /api/tickets/organizer/profile/logo (multipart 'logo') — vendor uploads its brand logo. */
  static async uploadLogo(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = (req as any).ticketsUser?.vendorId as string | undefined;
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Authentication required');

      const file = (req as any).file;
      if (!file) return ApiResponseUtil.validationError(res, 'No image uploaded');

      const vendor = await Vendor.findById(vendorId);
      if (!vendor) return ApiResponseUtil.error(res, 'Organizer not found', 404);

      const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase();
      const key = R2Service.generateMediaKey(`vendors/${vendor._id}/logo`, `logo.${ext}`);
      await R2Service.uploadBufferToR2(key, file.buffer, file.mimetype);
      const url = R2Service.getPublicUrl(key);

      const previous = vendor.logoUrl;
      vendor.logoUrl = url;
      await vendor.save();

      if (previous) {
        R2Service.deleteEventMediaByUrl(previous).catch((err) =>
          console.warn('Failed to delete previous logo (non-fatal):', err?.message),
        );
      }

      return ApiResponseUtil.success(res, { logoUrl: url }, 'Logo updated');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to upload logo');
    }
  }

  /** GET /api/public/organizers/:vendorId — PUBLIC brand page (spec §2.5). */
  static async publicProfile(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = String(req.params['vendorId'] || '');
      if (!HEX24.test(vendorId)) return ApiResponseUtil.error(res, 'vendorId must be an organizer id', 400);

      const vendor = await Vendor.findById(vendorId).select('businessName slug logoUrl bio isActive isSuperAdmin');
      if (!vendor || !vendor.isActive || vendor.isSuperAdmin) return ApiResponseUtil.error(res, 'Organizer not found', 404);

      const now = new Date();
      const eventFields = '_id name eventDate venue posterUrl thumbnailUrl';
      // Two axes on the follow graph: this brand's FOLLOWERS are counted by
      // targetType 'organizer' (it's a follow target), while the brands/people
      // this brand FOLLOWS are counted by followerType 'vendor' (it's the
      // actor) — same split /brand/me uses (vendorSocial.controller.ts).
      const [followerCount, followingCount, rating, upcoming, past, eventCount] = await Promise.all([
        FollowService.followerCount('organizer', vendorId),
        FollowService.followingCount(vendorId, 'vendor'),
        ReviewService.vendorAggregate(vendorId),
        Event.find({ vendorId, status: EventStatus.PUBLISHED, ...notEndedFilter(now) })
          .select(eventFields).sort({ eventDate: 1 }).limit(20),
        Event.find({
          vendorId,
          status: { $in: [EventStatus.PUBLISHED, EventStatus.COMPLETED] },
          ...endedFilter(now),
        }).select(eventFields).sort({ eventDate: -1 }).limit(20),
        // Total publicly-visible event count (union of the upcoming/past
        // queries above, minus their 20-item display cap) — drafts, pending
        // approval, and cancelled events are excluded by the status filter;
        // deleted events are hard-deleted (Event.deleteOne) so they can never
        // match.
        Event.countDocuments({ vendorId, status: { $in: [EventStatus.PUBLISHED, EventStatus.COMPLETED] } }),
      ]);

      const toSummary = (e: any) => ({
        id: String(e._id),
        name: e.name,
        eventDate: e.eventDate,
        venue: e.venue ?? null,
        posterUrl: e.posterUrl ?? e.thumbnailUrl ?? null,
      });

      return ApiResponseUtil.success(res, {
        id: String(vendor._id),
        businessName: vendor.businessName,
        slug: (vendor as any).slug ?? null,
        logoUrl: vendor.logoUrl ?? null,
        bio: vendor.bio ?? null,
        followerCount,
        followingCount,
        eventCount,
        rating,
        upcomingEvents: upcoming.map(toSummary),
        pastEvents: past.map(toSummary),
      });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load organizer profile');
    }
  }
}
