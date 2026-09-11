import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Ticket } from '@models/ticket.model';
import { Update } from '@models/update.model';
import { PushSubscription } from '@models/pushSubscription.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { ensureUsername, RESERVED_USERNAMES, USERNAME_REGEX } from '@utils/username.util';
import { toBuyerSummary } from '@utils/buyerSummary.util';
import { updateProfileSchema, blockSchema, followSchema, presenceSchema, pushSubscribeSchema, locationSchema } from '@validators/community.validator';
import { BlockService } from '@services/block.service';
import { FollowService } from '@services/follow.service';
import { FollowTargetType } from '@models/follow.model';
import { NotificationService } from '@services/notification.service';
import { SocialProfileViewService } from '@services/socialProfileView.service';
import { AccountActivityService } from '@services/accountActivity.service';
import { HEX24, failWithHttpError, parseMessageCursorParams } from '@utils/controllerHelpers.util';
import { onlineBuyerIds } from '@utils/buyerOnline.util';
import { DmEligibilityService } from '@services/dmEligibility.service';
import { vapidConfigured, VAPID_PUBLIC_KEY } from '@config/vapid.config';
import { totalStoryPoints } from '@services/storyPoints.service';
import { totalShareEarnPoints } from '@services/shareEarn.service';
import { NAME_CHANGE_COOLDOWN_MS } from '@models/buyer.model';

/** Human-readable form of the message the spec requires verbatim:
 *  "You can change your profile name again on [date]." */
function formatNameChangeDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** When a buyer may next change `name`, or null if unrestricted right now. */
function nameChangeLockedUntil(buyer: IBuyer): Date | null {
  if (!buyer.nameChangedAt) return null;
  const unlocksAt = new Date(buyer.nameChangedAt.getTime() + NAME_CHANGE_COOLDOWN_MS);
  return unlocksAt.getTime() > Date.now() ? unlocksAt : null;
}

export class SocialProfileController {
  /** Own-profile payload. NEVER include the phone — usernames are the public identity. */
  private static toOwnProfile(buyer: IBuyer) {
    const lockedUntil = nameChangeLockedUntil(buyer);
    return {
      id: String(buyer._id),
      username: buyer.username ?? null,
      usernameCustomized: Boolean(buyer.usernameCustomizedAt),
      name: buyer.name ?? null,
      // Non-null only while the 30-day cooldown is still in effect, so the
      // Edit Profile UI can disable the Name field and show the "You can
      // change your profile name again on [date]" hint proactively, instead
      // of only after a rejected save.
      nextNameChangeAt: lockedUntil ? lockedUntil.toISOString() : null,
      avatarUrl: buyer.avatarUrl ?? null,
      bio: buyer.bio ?? null,
      dmPrivacy: buyer.dmPrivacy,
      notificationPrefs: buyer.notificationPrefs,
      activityViewHistoryDisabled: Boolean(buyer.activityViewHistoryDisabled),
    };
  }

  /** GET /api/social/me */
  static async me(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      await ensureUsername(buyer);

      const myId = String(buyer._id);
      const [followerCount, followingCount, friendIds, attendedEventIds, postCount, storyPoints, shareEarnPoints] = await Promise.all([
        FollowService.followerCount('buyer', myId),
        FollowService.followingCount(myId),
        FollowService.friendIds(myId),
        Ticket.distinct('eventId', { customerPhone: buyer.phone, status: TicketStatus.CHECKED_IN }),
        // Same filter as UpdateController.listByAuthor, deliberately: this
        // count is shown next to that exact grid, and it also drives the
        // derived points total. A looser filter here would count posts the
        // buyer cannot see (removed, or still transcoding).
        Update.countDocuments({ authorType: 'buyer', authorId: myId, status: 'active', 'media.status': 'ready' }),
        // Unlike postCount/eventsAttended, this is NOT re-derivable from
        // live data — Stories TTL-delete after 48h, so it's a persisted
        // ledger total (see @services/storyPoints.service), not a count.
        totalStoryPoints(myId),
        // Same ledger reasoning as storyPoints — a Share&Earn points reward is
        // an event with no other durable record (see @services/shareEarn.service).
        totalShareEarnPoints(myId),
      ]);
      return ApiResponseUtil.success(res, {
        ...SocialProfileController.toOwnProfile(buyer),
        followerCount,
        followingCount,
        friendCount: friendIds.length,
        eventsAttended: attendedEventIds.length,
        postCount,
        storyPoints,
        shareEarnPoints,
      });
    } catch (error: any) {
      console.error('Get social profile error:', error);
      return ApiResponseUtil.error(res, error?.message || 'Failed to load profile', 500);
    }
  }

  /** PATCH /api/social/me — username / bio / dmPrivacy. */
  static async update(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const { error, value } = updateProfileSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      if (value.username !== undefined) {
        const username = String(value.username).toLowerCase();
        if (!USERNAME_REGEX.test(username)) {
          return ApiResponseUtil.error(res, 'Usernames are 3-20 characters: a-z, 0-9, _ and .', 400);
        }
        if (RESERVED_USERNAMES.includes(username)) {
          return ApiResponseUtil.error(res, 'That username is reserved', 409);
        }
        buyer.username = username;
        buyer.usernameCustomizedAt = new Date();
      }
      if (value.name !== undefined) {
        const name = String(value.name).trim();
        // Only a real change starts (or is blocked by) the cooldown — saving
        // the same name back is a no-op, not a "change".
        if (name !== (buyer.name ?? '')) {
          const lockedUntil = nameChangeLockedUntil(buyer);
          if (lockedUntil) {
            return ApiResponseUtil.error(
              res,
              `You can change your profile name again on ${formatNameChangeDate(lockedUntil)}.`,
              409
            );
          }
          buyer.name = name;
          buyer.nameChangedAt = new Date();
        }
      }
      if (value.bio !== undefined) buyer.bio = value.bio;
      if (value.dmPrivacy !== undefined) buyer.dmPrivacy = value.dmPrivacy;
      if (value.activityViewHistoryDisabled !== undefined) buyer.activityViewHistoryDisabled = value.activityViewHistoryDisabled;
      if (value.notificationPrefs !== undefined) {
        Object.assign(buyer.notificationPrefs, value.notificationPrefs);
        buyer.markModified('notificationPrefs');
      }

      try {
        await buyer.save();
      } catch (err: any) {
        if (err?.code === 11000) return ApiResponseUtil.error(res, 'That username is taken', 409);
        throw err;
      }
      return ApiResponseUtil.success(res, SocialProfileController.toOwnProfile(buyer), 'Profile updated');
    } catch (error: any) {
      console.error('Update social profile error:', error);
      return ApiResponseUtil.error(res, error?.message || 'Failed to update profile', 500);
    }
  }

  /** PATCH /api/social/me/location { lat, lng } — the nearby-people OPT-IN.
   *  No location exists until a buyer explicitly calls this. */
  static async updateLocation(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const { error, value } = locationSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      buyer.location = { type: 'Point', coordinates: [value.lng, value.lat] };
      buyer.locationUpdatedAt = new Date();
      await buyer.save();
      return ApiResponseUtil.success(
        res,
        { ok: true, location: buyer.location, locationUpdatedAt: buyer.locationUpdatedAt },
        'Location updated'
      );
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to update location');
    }
  }

  /** DELETE /api/social/me/location — the nearby-people OPT-OUT. */
  static async deleteLocation(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      await Buyer.updateOne({ _id: buyer._id }, { $unset: { location: 1, locationUpdatedAt: 1 } });
      return ApiResponseUtil.success(res, { ok: true }, 'Location removed');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to remove location');
    }
  }

  /** GET /api/social/users/:username — public profile. NEVER exposes phone or privacy settings. */
  static async publicProfile(req: Request, res: Response): Promise<any> {
    try {
      const username = String(req.params['username'] || '').toLowerCase();
      const viewer = await resolveBuyerFromRequest(req);
      if (!viewer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');

      const profile = await SocialProfileViewService.forViewer(username, { type: 'buyer', id: String(viewer._id) });
      if (!profile) return ApiResponseUtil.error(res, 'User not found', 404);
      // My Account insight (spec §1) — best-effort, never blocks the profile
      // response. record() itself no-ops on self-views, blocks, and a
      // disabled view-history privacy setting (spec §6).
      AccountActivityService.record({
        ownerId: profile.id, actorType: 'buyer', actorId: String(viewer._id), kind: 'profile_view',
      }).catch((err) => console.error('[account-activity] profile_view record failed:', err));
      return ApiResponseUtil.success(res, profile);
    } catch (error: any) {
      console.error('Get public profile error:', error);
      return ApiResponseUtil.error(res, error?.message || 'Failed to load profile', 500);
    }
  }

  /** GET /api/social/username-available?u=<candidate> */
  static async usernameAvailable(req: Request, res: Response): Promise<any> {
    try {
      const candidate = String(req.query['u'] || '').toLowerCase();
      if (!USERNAME_REGEX.test(candidate) || RESERVED_USERNAMES.includes(candidate)) {
        return ApiResponseUtil.success(res, { available: false });
      }
      const taken = await Buyer.exists({ username: candidate });
      return ApiResponseUtil.success(res, { available: !taken });
    } catch (error: any) {
      console.error('Username availability error:', error);
      return ApiResponseUtil.error(res, error?.message || 'Failed to check username', 500);
    }
  }

  private static failSocial(res: Response, error: any, fallback: string) {
    return failWithHttpError(res, error, fallback);
  }

  /** POST /api/social/follow */
  static async followTarget(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const { error, value } = followSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      await FollowService.follow(buyer, value.targetType, value.targetId);
      return ApiResponseUtil.success(res, { following: true }, 'Followed');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to follow');
    }
  }

  /** DELETE /api/social/follow/:targetType/:targetId */
  static async unfollowTarget(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const targetType = String(req.params['targetType'] || '');
      const targetId = String(req.params['targetId'] || '');
      if (!['buyer', 'organizer'].includes(targetType) || !/^[0-9a-f]{24}$/i.test(targetId)) {
        return ApiResponseUtil.error(res, 'Invalid follow target', 400);
      }
      await FollowService.unfollow(buyer, targetType as 'buyer' | 'organizer', targetId);
      return ApiResponseUtil.success(res, { following: false }, 'Unfollowed');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to unfollow');
    }
  }

  /** Shared {targetType, targetId} validation for the arbitrary-target follow
   *  list routes below — mirrors unfollowTarget's check. Returns null (after
   *  writing the 400) when invalid. */
  private static parseFollowTarget(req: Request, res: Response): { targetType: FollowTargetType; targetId: string } | null {
    const targetType = String(req.params['targetType'] || '');
    const targetId = String(req.params['targetId'] || '');
    if (!['buyer', 'organizer'].includes(targetType) || !/^[0-9a-f]{24}$/i.test(targetId)) {
      ApiResponseUtil.error(res, 'Invalid follow target', 400);
      return null;
    }
    return { targetType: targetType as FollowTargetType, targetId };
  }

  private static parsePageLimit(req: Request): { page: number; limit: number } {
    const page = Math.max(1, parseInt(String(req.query['page'] ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10) || 20));
    return { page, limit };
  }

  /** GET /api/social/followers/:targetType/:targetId?page=&limit= — who
   *  follows this buyer/organizer, as person rows. PUBLIC read (route is
   *  optionalTicketsAuth): anonymous and vendor callers get the list too.
   *  isFollowing is only ever resolved against a BUYER viewer's own follow
   *  graph — with no buyer viewer (anonymous or an organizer/vendor session)
   *  it's `false` for every row, never a crash. */
  static async followersList(req: Request, res: Response): Promise<any> {
    try {
      const viewer = await resolveBuyerFromRequest(req);
      const target = SocialProfileController.parseFollowTarget(req, res);
      if (!target) return;
      const { page, limit } = SocialProfileController.parsePageLimit(req);
      const rows = await FollowService.listFollowers(target.targetType, target.targetId, viewer ? String(viewer._id) : null, { page, limit });
      return ApiResponseUtil.success(res, rows);
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load followers');
    }
  }

  /** GET /api/social/following/:targetType/:targetId?page=&limit= — who this
   *  buyer/organizer follows, as person rows. PUBLIC read — see followersList
   *  above for the optional-viewer/isFollowing contract. */
  static async followingList(req: Request, res: Response): Promise<any> {
    try {
      const viewer = await resolveBuyerFromRequest(req);
      const target = SocialProfileController.parseFollowTarget(req, res);
      if (!target) return;
      const { page, limit } = SocialProfileController.parsePageLimit(req);
      const rows = await FollowService.listFollowing(target.targetType, target.targetId, viewer ? String(viewer._id) : null, { page, limit });
      return ApiResponseUtil.success(res, rows);
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load following');
    }
  }

  /** GET /api/social/me/following?type=buyer|organizer (default buyer) */
  static async myFollowing(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const type = req.query['type'] === 'organizer' ? 'organizer' : 'buyer';
      const ids = await FollowService.followingIds(String(buyer._id), type);
      if (type === 'organizer') {
        const vendors = await Vendor.find({ _id: { $in: ids } }).select('businessName slug');
        return ApiResponseUtil.success(res, vendors.map((v: any) => ({
          id: String(v._id), businessName: v.businessName, slug: v.slug ?? null,
        })));
      }
      const buyers = await Buyer.find({ _id: { $in: ids } });
      return ApiResponseUtil.success(res, buyers.map(toBuyerSummary));
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load following');
    }
  }

  /** GET /api/social/me/followers */
  static async myFollowers(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const ids = await FollowService.followerIds(String(buyer._id));
      const buyers = await Buyer.find({ _id: { $in: ids } });
      return ApiResponseUtil.success(res, buyers.map(toBuyerSummary));
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load followers');
    }
  }

  /** GET /api/social/me/friends */
  static async myFriends(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const ids = await FollowService.friendIds(String(buyer._id));
      const buyers = await Buyer.find({ _id: { $in: ids } });
      return ApiResponseUtil.success(res, buyers.map(toBuyerSummary));
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load friends');
    }
  }

  /**
   * GET /api/social/users/search?q= — matches display name (contains) OR
   * username (prefix), case-insensitive; excludes self + blocked either way.
   * Name matching is what lets you find the majority of people who have no
   * username yet (it's auto-generated only on a buyer's first social touch, so
   * pure ticket-buyers have none) — a username-only query left them invisible.
   */
  static async searchUsers(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const q = String(req.query['q'] || '').toLowerCase();
      if (q.length < 2 || q.length > 20) {
        return ApiResponseUtil.error(res, 'q must be 2-20 characters', 400);
      }
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const myId = String(buyer._id);
      const [iBlocked, blockedMe] = await Promise.all([
        BlockService.listBlockedIds(myId),
        BlockService.listBlockerIds(myId),
      ]);
      const excluded = [myId, ...iBlocked, ...blockedMe];

      const buyers = await Buyer.find({
        _id: { $nin: excluded },
        $or: [
          { name: { $regex: escaped, $options: 'i' } },
          { username: { $regex: `^${escaped}`, $options: 'i' } },
        ],
      }).limit(20);
      const dmable = await DmEligibilityService.canDmMap(myId, buyers.map((b) => String(b._id)));
      return ApiResponseUtil.success(
        res,
        buyers.map((b) => ({ ...toBuyerSummary(b), canDm: dmable.has(String(b._id)) }))
      );
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to search users');
    }
  }

  /** POST /api/social/block */
  static async blockUser(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const { error, value } = blockSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);
      await BlockService.block(buyer, value.userId);
      return ApiResponseUtil.success(res, { blocked: true }, 'User blocked');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to block user');
    }
  }

  /** DELETE /api/social/block/:userId */
  static async unblockUser(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const userId = String(req.params['userId'] || '');
      if (!/^[0-9a-f]{24}$/i.test(userId)) return ApiResponseUtil.error(res, 'userId must be a user id', 400);
      await BlockService.unblock(buyer, userId);
      return ApiResponseUtil.success(res, { blocked: false }, 'User unblocked');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to unblock user');
    }
  }

  /** GET /api/social/me/blocks — feeds client-side hiding of channel messages. */
  static async myBlocks(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const userIds = await BlockService.listBlockedIds(String(buyer._id));
      return ApiResponseUtil.success(res, { userIds });
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load blocks');
    }
  }

  /** GET /api/social/notifications */
  static async myNotifications(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const params = parseMessageCursorParams(req, res);
      if (!params) return;
      if (params.after) return ApiResponseUtil.error(res, 'after is not supported for notifications', 400);
      const result = await NotificationService.list('buyer', String(buyer._id), { before: params.before, limit: params.limit });
      return ApiResponseUtil.success(res, result);
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load notifications');
    }
  }

  /** POST /api/social/notifications/read { ids?: string[] } */
  static async markNotificationsRead(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const ids = req.body?.ids;
      if (ids !== undefined && (!Array.isArray(ids) || !ids.every((i: unknown) => typeof i === 'string' && HEX24.test(i)))) {
        return ApiResponseUtil.error(res, 'ids must be an array of notification ids', 400);
      }
      await NotificationService.markRead('buyer', String(buyer._id), ids);
      return ApiResponseUtil.success(res, { read: true }, 'Notifications marked read');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to mark notifications read');
    }
  }

  /** POST /api/social/presence { buyerIds: hex24[1..50] } -> { online: string[] }
   *  Same freshness window as the notification dispatcher's isBuyerOnline. */
  static async presence(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const { error, value } = presenceSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      const online = await onlineBuyerIds(value.buyerIds);
      return ApiResponseUtil.success(res, { online });
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to load presence');
    }
  }

  /** GET /api/social/push/vapid-public-key */
  static async vapidPublicKey(_req: Request, res: Response): Promise<any> {
    if (!vapidConfigured) return ApiResponseUtil.error(res, 'Push not configured', 503);
    return ApiResponseUtil.success(res, { key: VAPID_PUBLIC_KEY });
  }

  /** POST /api/social/push/subscribe */
  static async pushSubscribe(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const { error, value } = pushSubscribeSchema.validate(req.body);
      if (error) return ApiResponseUtil.error(res, error.message, 400);

      await PushSubscription.findOneAndUpdate(
        { endpoint: value.endpoint },
        {
          $set: {
            buyerId: buyer._id, // endpoint follows whoever is signed in on that browser
            keys: value.keys,
            userAgent: String(req.headers['user-agent'] || '').slice(0, 300) || undefined,
          },
        },
        { upsert: true, new: true, runValidators: true }
      );
      return ApiResponseUtil.success(res, { subscribed: true }, 'Push subscription saved');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to save push subscription');
    }
  }

  /** DELETE /api/social/push/subscribe { endpoint } */
  static async pushUnsubscribe(req: Request, res: Response): Promise<any> {
    try {
      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const endpoint = String(req.body?.endpoint || '');
      if (!endpoint) return ApiResponseUtil.error(res, 'endpoint is required', 400);
      await PushSubscription.deleteOne({ endpoint, buyerId: buyer._id });
      return ApiResponseUtil.success(res, { subscribed: false }, 'Push subscription removed');
    } catch (error: any) {
      return SocialProfileController.failSocial(res, error, 'Failed to remove push subscription');
    }
  }
}
