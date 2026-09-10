import { Follow, FollowTargetType, FollowerType } from '@models/follow.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { HttpError } from '@utils/httpError.util';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { NotificationService } from '@services/notification.service';
import { assertNotSuspended } from '@utils/socialSuspension.util';
import { AccountActivityService } from '@services/accountActivity.service';

/** The one public shape for "a person or brand" in a follow list — same
 *  field names for both, so a single list component can render buyer AND
 *  organizer rows without a type switch. A buyer row maps username/name/
 *  avatarUrl as-is; an organizer (Vendor) row maps slug -> username,
 *  businessName -> name, logoUrl -> avatarUrl. `type` tells the client which
 *  shape it got (buyer -> /u/:username, organizer -> /o/:id) without having
 *  to guess from field presence. */
export interface FollowPersonRow {
  id: string;
  type: 'buyer' | 'organizer';
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  isFollowing: boolean;
}

export interface FollowListOptions {
  page?: number;
  limit?: number;
}

export class FollowService {
  /**
   * Create a follow edge. Returns true if newly created, false if it already
   * existed (idempotent). Throws 400 on self-follow, 404 on unknown target.
   */
  private static async createEdge(
    followerType: FollowerType,
    followerId: string,
    targetType: FollowTargetType,
    targetId: string
  ): Promise<boolean> {
    const selfFollow =
      (followerType === 'buyer' && targetType === 'buyer' && followerId === targetId) ||
      (followerType === 'vendor' && targetType === 'organizer' && followerId === targetId);
    if (selfFollow) throw new HttpError(400, 'You cannot follow yourself');

    const exists =
      targetType === 'buyer' ? await Buyer.exists({ _id: targetId }) : await Vendor.exists({ _id: targetId });
    if (!exists) throw new HttpError(404, 'User not found');

    try {
      await Follow.create({ followerType, followerId, targetType, targetId });
      return true;
    } catch (err: any) {
      if (err?.code !== 11000) throw err; // already following — idempotent
      return false;
    }
  }

  /** Best-effort: tell a brand it gained a follower. Never throws into the follow path. */
  private static async notifyOrganizerFollowed(vendorId: string, followerType: FollowerType, followerId: string): Promise<void> {
    try {
      let name = 'Someone';
      // `username` is carried in the payload so the notification row can link
      // to the follower's profile (/u/:username) — without it a "new follower"
      // notification has nowhere to go when tapped.
      let username: string | undefined;
      if (followerType === 'buyer') {
        const b = await Buyer.findById(followerId).select('username name');
        name = b?.username ?? b?.name ?? 'Someone';
        username = b?.username ?? undefined;
      } else {
        const v = await Vendor.findById(followerId).select('businessName');
        name = v?.businessName ?? 'A brand';
      }
      await NotificationService.create('vendor', vendorId, 'follow', 'New follower', `${name} started following you`, {
        followerType,
        followerId,
        ...(username ? { username } : {}),
      });
    } catch (err: any) {
      console.error(`[follow] notify organizer ${vendorId} failed:`, err?.message);
    }
  }

  static async follow(buyer: IBuyer, targetType: FollowTargetType, targetId: string): Promise<void> {
    assertNotSuspended(buyer);
    // Checked OUTSIDE the try so it fires on a fresh create AND survives a
    // retry after a transient error on the create itself — but never fires
    // on the pure-duplicate (already-following) path, since `created` stays
    // false there.
    const created = await FollowService.createEdge('buyer', String(buyer._id), targetType, targetId);
    if (created && targetType === 'organizer') {
      await FollowService.notifyOrganizerFollowed(targetId, 'buyer', String(buyer._id));
    }
    if (created && targetType === 'buyer' && (await FollowService.isFriend(String(buyer._id), targetId))) {
      // buyer's follow completed the mutual — tell the other party.
      NotificationDispatcher.dispatchAsync(
        [targetId],
        'friend',
        buyer.username ?? buyer.name ?? 'Someone',
        'followed you back — you are now friends',
        // The notified party (targetId) is being told about buyer, their new
        // friend — username lets the client route straight to buyer's
        // profile, same identity buyerId already points at.
        { buyerId: String(buyer._id), username: buyer.username ?? null },
        String(buyer._id)
      );
    }
  }

  static async unfollow(buyer: IBuyer, targetType: FollowTargetType, targetId: string): Promise<void> {
    const { deletedCount } = await Follow.deleteOne({ followerType: 'buyer', followerId: buyer._id, targetType, targetId });
    // My Account insight (spec §1) — buyer-owned targets only ("organizer"
    // targets have their own follower-analytics surface, out of scope here).
    // Only on an actual unfollow (deletedCount>0), never on a no-op
    // (already-not-following) delete.
    if (deletedCount > 0 && targetType === 'buyer') {
      AccountActivityService.record({
        ownerId: targetId, actorType: 'buyer', actorId: String(buyer._id), kind: 'unfollow',
      }).catch((err) => console.error('[account-activity] unfollow record failed:', err));
    }
  }

  /**
   * A completed ticket purchase auto-follows the event's organizer — the same
   * buyer→organizer edge a manual "Follow" tap creates (notification included),
   * reusing createEdge + notifyOrganizerFollowed so there is one follow path.
   *
   * Registered buyers only: no-ops when `buyerId` is absent (guest / POS
   * walk-up checkout has no Buyer account to attach) or `vendorId` is absent
   * (self-listed community events carry no organizer brand to follow). Unlike
   * the manual follow it does not gate on suspension — this is a system side
   * effect of a purchase, not a social action, and only the id is in hand here.
   *
   * Best-effort: any failure is swallowed and logged so a follow hiccup can
   * never break ticket issuance (the vital path). Idempotent via the follow
   * unique index, so webhook + reconcile both re-finalizing a sale is safe.
   */
  static async autoFollowOrganizer(buyerId?: string | null, vendorId?: string | null): Promise<void> {
    if (!buyerId || !vendorId) return;
    try {
      const created = await FollowService.createEdge('buyer', String(buyerId), 'organizer', String(vendorId));
      if (created) await FollowService.notifyOrganizerFollowed(String(vendorId), 'buyer', String(buyerId));
    } catch (err: any) {
      console.error(`[follow] auto-follow organizer ${vendorId} for buyer ${buyerId} failed:`, err?.message);
    }
  }

  /** The brand follows a buyer or another organizer. No suspension, no friend concept. */
  static async followAsVendor(vendorId: string, targetType: FollowTargetType, targetId: string): Promise<void> {
    const created = await FollowService.createEdge('vendor', String(vendorId), targetType, targetId);
    if (created && targetType === 'organizer') {
      await FollowService.notifyOrganizerFollowed(targetId, 'vendor', String(vendorId));
    }
  }

  static async unfollowAsVendor(vendorId: string, targetType: FollowTargetType, targetId: string): Promise<void> {
    await Follow.deleteOne({ followerType: 'vendor', followerId: vendorId, targetType, targetId });
  }

  /** Mutual buyer-follow. */
  static async isFriend(buyerIdA: string, buyerIdB: string): Promise<boolean> {
    const [ab, ba] = await Promise.all([
      Follow.exists({ followerId: buyerIdA, targetType: 'buyer', targetId: buyerIdB }),
      Follow.exists({ followerId: buyerIdB, targetType: 'buyer', targetId: buyerIdA }),
    ]);
    return Boolean(ab && ba);
  }

  static async followerCount(targetType: FollowTargetType, targetId: string): Promise<number> {
    return Follow.countDocuments({ targetType, targetId });
  }

  static async followingCount(followerId: string, followerType: FollowerType = 'buyer'): Promise<number> {
    return Follow.countDocuments({ followerType, followerId });
  }

  static async followingIds(
    followerId: string,
    targetType: FollowTargetType,
    followerType: FollowerType = 'buyer'
  ): Promise<string[]> {
    const rows = await Follow.find({ followerType, followerId, targetType }).select('targetId');
    return rows.map((r) => String(r.targetId));
  }

  /** Buyers who follow this buyer. */
  static async followerIds(buyerId: string): Promise<string[]> {
    const rows = await Follow.find({ targetType: 'buyer', targetId: buyerId }).select('followerId');
    return rows.map((r) => String(r.followerId));
  }

  /** Mutuals: I follow them AND they follow me. */
  static async friendIds(buyerId: string): Promise<string[]> {
    const iFollow = await FollowService.followingIds(buyerId, 'buyer');
    if (iFollow.length === 0) return [];
    const back = await Follow.find({
      followerId: { $in: iFollow },
      targetType: 'buyer',
      targetId: buyerId,
    }).select('followerId');
    return back.map((r) => String(r.followerId));
  }

  /** Buyers following an organizer — announcement fan-out audience. */
  static async organizerFollowerIds(vendorId: string): Promise<string[]> {
    const rows = await Follow.find({ targetType: 'organizer', targetId: vendorId }).select('followerId');
    return rows.map((r) => String(r.followerId));
  }

  /** Followers of an organizer brand, WITH their type (buyers and/or other brands). */
  static async followersOfOrganizer(vendorId: string): Promise<{ followerType: FollowerType; followerId: string }[]> {
    const rows = await Follow.find({ targetType: 'organizer', targetId: vendorId }).select('followerType followerId');
    return rows.map((r) => ({ followerType: r.followerType, followerId: String(r.followerId) }));
  }

  /** Hydrates raw (type, id) follow-edge endpoints into the shared person-row
   *  DTO, resolving `isFollowing` for the viewer in two batched queries
   *  (never N+1). Rows whose underlying Buyer/Vendor no longer exists are
   *  dropped silently (same convention as the other list endpoints here).
   *  `viewerId` is null for anonymous/organizer callers (no buyer follow
   *  graph to resolve) — skip the lookup entirely rather than pass a falsy
   *  id into the Follow query, which Mongo would otherwise treat as "no
   *  followerId filter" and match everyone's follows. */
  private static async hydrateRows(
    entries: Array<{ type: FollowTargetType; id: string }>,
    viewerId: string | null
  ): Promise<FollowPersonRow[]> {
    const buyerIds = entries.filter((e) => e.type === 'buyer').map((e) => e.id);
    const orgIds = entries.filter((e) => e.type === 'organizer').map((e) => e.id);

    const [buyers, vendors, viewerFollowingBuyers, viewerFollowingOrgs] = await Promise.all([
      buyerIds.length ? Buyer.find({ _id: { $in: buyerIds } }) : Promise.resolve([]),
      orgIds.length ? Vendor.find({ _id: { $in: orgIds } }).select('businessName slug logoUrl') : Promise.resolve([]),
      viewerId ? FollowService.followingIds(viewerId, 'buyer') : Promise.resolve([]),
      viewerId ? FollowService.followingIds(viewerId, 'organizer') : Promise.resolve([]),
    ]);
    const buyerMap = new Map(buyers.map((b: any) => [String(b._id), b]));
    const vendorMap = new Map(vendors.map((v: any) => [String(v._id), v]));
    const followingBuyerSet = new Set(viewerFollowingBuyers);
    const followingOrgSet = new Set(viewerFollowingOrgs);

    const rows: FollowPersonRow[] = [];
    for (const entry of entries) {
      if (entry.type === 'buyer') {
        const b = buyerMap.get(entry.id);
        if (!b) continue;
        rows.push({
          id: entry.id,
          type: 'buyer',
          username: b.username ?? null,
          name: b.name ?? null,
          avatarUrl: b.avatarUrl ?? null,
          isFollowing: followingBuyerSet.has(entry.id),
        });
      } else {
        const v: any = vendorMap.get(entry.id);
        if (!v) continue;
        rows.push({
          id: entry.id,
          type: 'organizer',
          username: v.slug ?? null,
          name: v.businessName ?? null,
          avatarUrl: v.logoUrl ?? null,
          isFollowing: followingOrgSet.has(entry.id),
        });
      }
    }
    return rows;
  }

  /** GET .../followers/:targetType/:targetId — who follows this target,
   *  newest-follow first, with isFollowing resolved for `viewerId`. */
  static async listFollowers(
    targetType: FollowTargetType,
    targetId: string,
    viewerId: string | null,
    { page = 1, limit = 20 }: FollowListOptions = {}
  ): Promise<FollowPersonRow[]> {
    const skip = (Math.max(1, page) - 1) * limit;
    const follows = await Follow.find({ targetType, targetId })
      .sort({ createdAt: -1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .select('followerType followerId');
    const entries = follows.map((f) => ({
      type: (f.followerType === 'vendor' ? 'organizer' : 'buyer') as FollowTargetType,
      id: String(f.followerId),
    }));
    return FollowService.hydrateRows(entries, viewerId);
  }

  /** GET .../following/:targetType/:targetId — who this target follows,
   *  newest-follow first, with isFollowing resolved for `viewerId`. */
  static async listFollowing(
    targetType: FollowTargetType,
    targetId: string,
    viewerId: string | null,
    { page = 1, limit = 20 }: FollowListOptions = {}
  ): Promise<FollowPersonRow[]> {
    const followerType: FollowerType = targetType === 'organizer' ? 'vendor' : 'buyer';
    const skip = (Math.max(1, page) - 1) * limit;
    const follows = await Follow.find({ followerType, followerId: targetId })
      .sort({ createdAt: -1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .select('targetType targetId');
    const entries = follows.map((f) => ({ type: f.targetType, id: String(f.targetId) }));
    return FollowService.hydrateRows(entries, viewerId);
  }
}
