import { Buyer } from '@models/buyer.model';
import { Follow } from '@models/follow.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { FollowService } from '@services/follow.service';
import { BlockService } from '@services/block.service';
import { MeetupService } from '@services/meetup.service';
import { MeetupStatus } from '@models/meetupRequest.model';
import type { SocialActor } from '@utils/socialActor.util';

/** The one public shape for "a buyer's profile page", shared by every viewer type. */
export interface PublicBuyerProfile {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  bio: string | null;
  joinedAt: Date;
  followerCount: number;
  followingCount: number;
  eventsAttended: number;
  isFollowing: boolean;
  isFollowedBy: boolean;
  isFriend: boolean;
  isBlocked: boolean;
  meetupStatus: MeetupStatus | 'none';
  meetupRequestId: string | null;
  canDm: boolean;
}

export class SocialProfileViewService {
  /**
   * Build GET .../users/:username's payload for a given viewer actor
   * (buyer OR vendor brand). Shared by SocialProfileController.publicProfile
   * (buyer viewer, mounted at /api/social) and
   * VendorSocialController.publicProfile (vendor viewer, mounted at
   * /api/tickets/social) so the two routes can never drift on shape or on
   * how the viewer-relative flags are derived. Accepts either a username OR a
   * raw buyer id: a usernameless buyer (username is auto-generated only on a
   * buyer's first social touch) has no /u/:username address, so link surfaces
   * fall back to /u/:id. A real username can never be 24 hex chars
   * (USERNAME_REGEX caps them at [a-z0-9_.]{3,20}), so the shape is
   * unambiguous — hex-24 → look up by _id, otherwise by username. Returns null
   * when no buyer matches — callers translate that into a 404.
   */
  static async forViewer(usernameOrId: string, viewer: SocialActor): Promise<PublicBuyerProfile | null> {
    const buyer = /^[0-9a-f]{24}$/.test(usernameOrId)
      ? await Buyer.findById(usernameOrId)
      : await Buyer.findOne({ username: usernameOrId });
    if (!buyer) return null;

    const targetId = String(buyer._id);
    // A follow-of-the-viewer edge targets 'organizer' when the viewer is a
    // vendor brand, 'buyer' when the viewer is a buyer — mirrors targetType
    // on the Follow model (@models/follow.model.ts).
    const viewerTargetType = viewer.type === 'vendor' ? 'organizer' : 'buyer';

    const [followerCount, followingCount, attendedEventIds, isFollowing, isFollowedBy, isBlocked] = await Promise.all([
      FollowService.followerCount('buyer', targetId),
      FollowService.followingCount(targetId),
      Ticket.distinct('eventId', { customerPhone: buyer.phone, status: TicketStatus.CHECKED_IN }),
      Follow.exists({ followerType: viewer.type, followerId: viewer.id, targetType: 'buyer', targetId }).then(Boolean),
      Follow.exists({ followerType: 'buyer', followerId: targetId, targetType: viewerTargetType, targetId: viewer.id }).then(Boolean),
      BlockService.isBlockedEitherWay(viewer.id, targetId),
    ]);

    // canDm no longer depends on viewer type or a meetup/follow connection —
    // any signed-in buyer or vendor may DM a non-blocked buyer.
    let meetupStatus: MeetupStatus | 'none' = 'none';
    let meetupRequestId: string | null = null;
    if (viewer.type === 'buyer') {
      const statusMap = await MeetupService.outgoingStatusMap(viewer.id, [targetId]);
      const m = statusMap.get(targetId);
      meetupStatus = m ? m.status : 'none';
      meetupRequestId = m ? m.id : null;
    }
    const canDm = !isBlocked;

    return {
      id: targetId,
      username: buyer.username ?? null,
      name: buyer.name ?? null,
      avatarUrl: buyer.avatarUrl ?? null,
      bio: buyer.bio ?? null,
      joinedAt: buyer.createdAt,
      followerCount,
      followingCount,
      eventsAttended: attendedEventIds.length,
      isFollowing,
      isFollowedBy,
      // Matches FollowService.isFriend's buyer<->buyer definition exactly
      // (mutual follow, both directions) generalized to any viewer actor.
      isFriend: isFollowing && isFollowedBy,
      isBlocked,
      meetupStatus,
      meetupRequestId,
      canDm,
    };
  }
}
