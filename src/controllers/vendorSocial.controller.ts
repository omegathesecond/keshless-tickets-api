import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { FollowService } from '@services/follow.service';
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { BlockService } from '@services/block.service';
import { NotificationService } from '@services/notification.service';
import { followSchema } from '@validators/community.validator';
import { HEX24, failWithHttpError, parseMessageCursorParams } from '@utils/controllerHelpers.util';
import { toBuyerSummary } from '@utils/buyerSummary.util';
import { toVendorSummary } from '@utils/vendorSummary.util';
import { SocialProfileViewService } from '@services/socialProfileView.service';
import { AccountActivityService } from '@services/accountActivity.service';

/** Social-graph endpoints where the acting identity is the organizer brand (Vendor). */
export class VendorSocialController {
  private static vendorId(req: Request): string | undefined {
    return (req as any).ticketsUser?.vendorId;
  }

  /**
   * Whether this session may edit the brand's identity (logo/bio).
   *
   * Mirrors requireTicketsPermission's read of req.ticketsUser.permissions —
   * the same bar POST /api/tickets/organizer/profile/logo enforces. Exposed
   * so clients never offer a brand-identity action a sub-user would be 403'd
   * out of (notably the PhotoGate, whose only exit IS the logo upload: a
   * SALES/SCANNER staffer of a logoless vendor would otherwise be shown a
   * non-dismissible gate they can never satisfy).
   *
   * Checks EDIT_BRAND, not EDIT_EVENT — brand identity is vertical-neutral
   * (a bus company's brand is not an events concept), so this now works for
   * TRANSPORT and BOTH operators, not just EVENTS ones.
   */
  private static canEditBrand(req: Request): boolean {
    const permissions = (req as any).ticketsUser?.permissions || [];
    return permissions.includes(TicketsPermission.EDIT_BRAND);
  }

  /** GET /api/tickets/social/me — the brand's own social summary. */
  static async me(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const vendor = await Vendor.findById(vendorId).select('businessName slug logoUrl bio operatorType');
      if (!vendor) return ApiResponseUtil.notFound(res, 'Organizer not found');
      const [followerCount, followingCount] = await Promise.all([
        FollowService.followerCount('organizer', vendorId),
        FollowService.followingCount(vendorId, 'vendor'),
      ]);
      return ApiResponseUtil.success(res, {
        id: String(vendor._id),
        businessName: vendor.businessName,
        slug: (vendor as any).slug ?? null,
        logoUrl: vendor.logoUrl ?? null,
        bio: vendor.bio ?? null,
        operatorType: (vendor as any).operatorType,
        followerCount,
        followingCount,
        canEditBrand: VendorSocialController.canEditBrand(req),
      });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load brand profile');
    }
  }

  /** POST /api/tickets/social/follow */
  static async follow(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const { error, value } = followSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      await FollowService.followAsVendor(vendorId, value.targetType, value.targetId);
      return ApiResponseUtil.success(res, { following: true }, 'Followed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to follow');
    }
  }

  /** DELETE /api/tickets/social/follow/:targetType/:targetId */
  static async unfollow(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const targetType = String(req.params['targetType'] || '');
      const targetId = String(req.params['targetId'] || '');
      if (!['buyer', 'organizer'].includes(targetType) || !/^[0-9a-f]{24}$/i.test(targetId)) {
        return ApiResponseUtil.error(res, 'Invalid follow target', 400);
      }
      await FollowService.unfollowAsVendor(vendorId, targetType as 'buyer' | 'organizer', targetId);
      return ApiResponseUtil.success(res, { following: false }, 'Unfollowed');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to unfollow');
    }
  }

  /** GET /api/tickets/social/me/following — buyers + brands this brand follows. */
  static async following(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const [buyerIds, orgIds] = await Promise.all([
        FollowService.followingIds(vendorId, 'buyer', 'vendor'),
        FollowService.followingIds(vendorId, 'organizer', 'vendor'),
      ]);
      const [buyers, organizers] = await Promise.all([
        Buyer.find({ _id: { $in: buyerIds } }),
        Vendor.find({ _id: { $in: orgIds } }).select('businessName slug logoUrl'),
      ]);
      return ApiResponseUtil.success(res, { buyers: buyers.map(toBuyerSummary), organizers: organizers.map(toVendorSummary) });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load following');
    }
  }

  /** GET /api/tickets/social/me/followers — buyers + brands that follow this brand. */
  static async followers(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const rows = await FollowService.followersOfOrganizer(vendorId);
      const buyerIds = rows.filter((r) => r.followerType === 'buyer').map((r) => r.followerId);
      const vendorIds = rows.filter((r) => r.followerType === 'vendor').map((r) => r.followerId);
      const [buyers, organizers] = await Promise.all([
        Buyer.find({ _id: { $in: buyerIds } }),
        Vendor.find({ _id: { $in: vendorIds } }).select('businessName slug logoUrl'),
      ]);
      return ApiResponseUtil.success(res, { buyers: buyers.map(toBuyerSummary), organizers: organizers.map(toVendorSummary) });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load followers');
    }
  }

  /**
   * GET /api/tickets/social/users/:username — a buyer's public profile, as
   * seen by this vendor brand. Same response shape as
   * SocialProfileController.publicProfile (GET /api/social/users/:username,
   * the buyer-viewer route) — both delegate to
   * SocialProfileViewService.forViewer so they can never drift. NEVER
   * exposes the buyer's phone or privacy settings.
   */
  static async publicProfile(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const username = String(req.params['username'] || '').toLowerCase();
      const profile = await SocialProfileViewService.forViewer(username, { type: 'vendor', id: vendorId });
      if (!profile) return ApiResponseUtil.error(res, 'User not found', 404);
      // My Account insight (spec §1) — mirrors SocialProfileController.publicProfile's
      // buyer-viewer hook so an organizer brand viewing a buyer's profile counts too.
      AccountActivityService.record({
        ownerId: profile.id, actorType: 'vendor', actorId: vendorId, kind: 'profile_view',
      }).catch((err: unknown) => console.error('[account-activity] profile_view record failed:', err));
      return ApiResponseUtil.success(res, profile);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load profile');
    }
  }

  /** GET /api/tickets/social/users/search?q= — buyers by name (contains) or username (prefix) + brands by name. */
  static async searchUsers(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const q = String(req.query['q'] || '').toLowerCase();
      if (q.length < 2 || q.length > 30) return ApiResponseUtil.error(res, 'q must be 2-30 characters', 400);
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // No block filtering: block is not a vendor concept until SP1b-c.
      // Match buyer display name too, not just username — usernameless
      // ticket-buyers (username is auto-generated on first social touch) were
      // unfindable when this only matched the handle.
      const [buyers, brands] = await Promise.all([
        Buyer.find({
          $or: [
            { name: { $regex: escaped, $options: 'i' } },
            { username: { $regex: `^${escaped}`, $options: 'i' } },
          ],
        }).limit(20),
        Vendor.find({ businessName: { $regex: escaped, $options: 'i' }, isActive: true, isSuperAdmin: { $ne: true }, _id: { $ne: vendorId } })
          .select('businessName slug logoUrl').limit(20),
      ]);
      return ApiResponseUtil.success(res, { buyers: buyers.map(toBuyerSummary), organizers: brands.map(toVendorSummary) });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to search accounts');
    }
  }

  /** GET /api/tickets/social/notifications?before=&limit= */
  static async notifications(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const params = parseMessageCursorParams(req, res);
      if (!params) return;
      if (params.after) return ApiResponseUtil.error(res, 'after is not supported for notifications', 400);
      const result = await NotificationService.list('vendor', vendorId, { before: params.before, limit: params.limit });
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load notifications');
    }
  }

  /** POST /api/tickets/social/notifications/read { ids?: string[] } */
  static async markNotificationsRead(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const ids = req.body?.ids;
      if (ids !== undefined && (!Array.isArray(ids) || !ids.every((i: unknown) => typeof i === 'string' && HEX24.test(i)))) {
        return ApiResponseUtil.error(res, 'ids must be an array of notification ids', 400);
      }
      await NotificationService.markRead('vendor', vendorId, ids);
      return ApiResponseUtil.success(res, { read: true }, 'Notifications marked read');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to mark notifications read');
    }
  }

  /** POST /api/tickets/social/block { userId } — the brand blocks a buyer. */
  static async blockUser(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const userId = String(req.body?.userId || '');
      if (!HEX24.test(userId)) return ApiResponseUtil.error(res, 'userId is required', 400);
      await BlockService.blockAsVendor(vendorId, userId);
      return ApiResponseUtil.success(res, { blocked: true }, 'User blocked');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to block user');
    }
  }

  /** DELETE /api/tickets/social/block/:userId */
  static async unblockUser(req: Request, res: Response): Promise<any> {
    try {
      const vendorId = VendorSocialController.vendorId(req);
      if (!vendorId) return ApiResponseUtil.unauthorized(res, 'Vendor sign-in required');
      const userId = String(req.params['userId'] || '');
      if (!HEX24.test(userId)) return ApiResponseUtil.error(res, 'userId must be a user id', 400);
      await BlockService.unblockAsVendor(vendorId, userId);
      return ApiResponseUtil.success(res, { blocked: false }, 'User unblocked');
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to unblock user');
    }
  }
}
