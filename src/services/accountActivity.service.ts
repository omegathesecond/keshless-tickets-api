import { Types } from 'mongoose';
import { AccountActivityEvent, AccountActivityKind, AccountActivityActorType } from '@models/accountActivityEvent.model';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Story } from '@models/story.model';
import { Update } from '@models/update.model';
import { BlockService } from '@services/block.service';

/** How long a repeat (owner, actor, kind, target) occurrence is folded into
 *  the PREVIOUS row instead of creating a new one. This is what keeps "5
 *  times" meaning "5 distinct visits" rather than exploding on a page
 *  refresh, a React double-effect, or a viewer idling on a profile with a
 *  poll running. story_view needs no entry here — StorySeen's own unique
 *  (story, viewer) index already makes markSeen fire record() at most once
 *  per story per viewer, so there is nothing to throttle. */
const THROTTLE_MS: Partial<Record<AccountActivityKind, number>> = {
  profile_view: 30 * 60 * 1000,
  post_view: 30 * 60 * 1000,
};

export interface AccountActivityActorInfo {
  type: AccountActivityActorType;
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  href: string;
}

export interface AccountActivityTargetInfo {
  kind: 'story' | 'post';
  id: string;
  imageUrl: string | null;
  href: string;
  /** false once the underlying Story/Update no longer resolves (expired
   *  Story, removed post) — the group still renders (the insight itself
   *  stays true), just without a clickable/openable preview. */
  available: boolean;
}

export interface AccountActivityGroup {
  /** Stable client key AND the payload for mark-read: `${kind}:${actorType}:${actorId}:${targetId ?? ''}`. */
  key: string;
  kind: AccountActivityKind;
  actor: AccountActivityActorInfo;
  target: AccountActivityTargetInfo | null;
  count: number;
  lastAt: string;
  unread: boolean;
}

export interface RecordInput {
  ownerId: string;
  actorType: AccountActivityActorType;
  actorId: string;
  kind: AccountActivityKind;
  targetId?: string;
}

function groupKey(actorType: string, actorId: string, kind: string, targetId?: string | null): string {
  return `${kind}:${actorType}:${actorId}:${targetId ?? ''}`;
}

export class AccountActivityService {
  /**
   * Log one raw occurrence, or fold it into a recent one within the
   * throttle window. Best-effort by convention (every call site wraps this
   * in .catch — a view is a side effect of a read, never allowed to break
   * the read it rides along with).
   *
   * Skips silently (not an error) when:
   *  - the actor is the owner (viewing your own profile/story/post is not an insight)
   *  - the actor is a buyer with `activityViewHistoryDisabled` (spec §6 privacy toggle)
   *  - owner and actor have blocked each other either way (spec §6 "respect blocked accounts")
   */
  static async record(input: RecordInput): Promise<void> {
    const { ownerId, actorType, actorId, kind, targetId } = input;
    if (ownerId === actorId && actorType === 'buyer') return; // self-view

    // Block.blockerId/blockedId are actor-agnostic ids (BlockService.blockActor
    // accepts a buyer OR vendor target), so this check applies regardless of
    // actorType — a buyer who blocked an organizer brand must not appear as an
    // insight to that brand, and vice versa.
    if (await BlockService.isBlockedEitherWay(ownerId, actorId)) return;

    if (actorType === 'buyer') {
      // Privacy toggle (spec §6) only exists on Buyer — a vendor brand has no
      // equivalent "hide my views" setting yet.
      const actor = await Buyer.findById(actorId).select('activityViewHistoryDisabled');
      if (actor?.activityViewHistoryDisabled) return;
    }

    const throttleMs = THROTTLE_MS[kind];
    if (throttleMs) {
      const recent = await AccountActivityEvent.exists({
        ownerId,
        actorType,
        actorId,
        kind,
        targetId: targetId ?? null,
        createdAt: { $gte: new Date(Date.now() - throttleMs) },
      });
      if (recent) return;
    }

    await AccountActivityEvent.create({
      ownerId,
      actorType,
      actorId,
      kind,
      targetId: targetId ?? undefined,
    });
  }

  /**
   * Grouped, most-recent-first page of an owner's My Account insights.
   * Groups raw events by (actorType, actorId, kind, targetId) — "Thulas
   * viewed your Story 3 times" is one group carrying count:3 and the
   * timestamp of the latest occurrence (spec §1/§3). Blocked actors are
   * filtered the same way ActivityPage already filters the public feed
   * client-side, but here it's server-side since this is a private, paged
   * aggregation rather than a small client-held list.
   *
   * cursor is the ISO `lastAt` of the last group on the previous page —
   * groups strictly older than it are the next page. limit caps GROUPS
   * returned, not raw events.
   */
  static async list(
    ownerId: string,
    opts: { cursor?: string; limit?: number } = {}
  ): Promise<{ items: AccountActivityGroup[]; nextCursor: string | null; unreadCount: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 50);

    const [blockedByMe, blockedMe] = await Promise.all([
      BlockService.listBlockedIds(ownerId).catch(() => [] as string[]),
      BlockService.listBlockerIds(ownerId).catch(() => [] as string[]),
    ]);
    const blockedIds = [...new Set([...blockedByMe, ...blockedMe])];
    const match: Record<string, unknown> = { ownerId: new Types.ObjectId(ownerId) };
    if (blockedIds.length) match['actorId'] = { $nin: blockedIds.map((id) => new Types.ObjectId(id)) };

    const pipeline: any[] = [
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { actorType: '$actorType', actorId: '$actorId', kind: '$kind', targetId: '$targetId' },
          count: { $sum: 1 },
          lastAt: { $max: '$createdAt' },
          hasUnread: { $max: { $cond: [{ $eq: ['$readAt', null] }, 1, 0] } },
        },
      },
      { $sort: { lastAt: -1 } },
    ];
    if (opts.cursor) {
      pipeline.push({ $match: { lastAt: { $lt: new Date(opts.cursor) } } }, { $sort: { lastAt: -1 } });
    }
    pipeline.push({ $limit: limit + 1 });

    const rows = await AccountActivityEvent.aggregate<{
      _id: { actorType: AccountActivityActorType; actorId: Types.ObjectId; kind: AccountActivityKind; targetId?: Types.ObjectId };
      count: number;
      lastAt: Date;
      hasUnread: number;
    }>(pipeline);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    const buyerIds = [...new Set(page.filter((r) => r._id.actorType === 'buyer').map((r) => String(r._id.actorId)))];
    const vendorIds = [...new Set(page.filter((r) => r._id.actorType === 'vendor').map((r) => String(r._id.actorId)))];
    const storyIds = [...new Set(page.filter((r) => r._id.kind === 'story_view' && r._id.targetId).map((r) => String(r._id.targetId)))];
    const updateIds = [...new Set(page.filter((r) => r._id.kind === 'post_view' && r._id.targetId).map((r) => String(r._id.targetId)))];

    const [buyers, vendors, stories, updates, unreadCount] = await Promise.all([
      buyerIds.length ? Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl') : [],
      vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select('businessName slug logoUrl') : [],
      storyIds.length ? Story.find({ _id: { $in: storyIds } }).select('media') : [],
      updateIds.length ? Update.find({ _id: { $in: updateIds } }).select('media caption status') : [],
      AccountActivityService.unreadCount(ownerId),
    ]);
    const buyerMap = new Map(buyers.map((b: any) => [String(b._id), b]));
    const vendorMap = new Map(vendors.map((v: any) => [String(v._id), v]));
    const storyMap = new Map(stories.map((s: any) => [String(s._id), s]));
    const updateMap = new Map(updates.map((u: any) => [String(u._id), u]));

    const items: AccountActivityGroup[] = page
      .map((r) => {
        const actorId = String(r._id.actorId);
        let actor: AccountActivityActorInfo | null = null;
        if (r._id.actorType === 'buyer') {
          const b = buyerMap.get(actorId);
          if (!b) return null; // deleted account — drop the row (same convention as the public feed)
          actor = {
            type: 'buyer', id: actorId,
            name: b.name ?? null, username: b.username ?? null, avatarUrl: b.avatarUrl ?? null,
            href: b.username ? `/u/${b.username}` : `/u/${actorId}`,
          };
        } else {
          const v = vendorMap.get(actorId);
          if (!v) return null;
          actor = {
            type: 'vendor', id: actorId,
            name: v.businessName ?? null, username: v.slug ?? null, avatarUrl: v.logoUrl ?? null,
            href: `/o/${actorId}`,
          };
        }

        let target: AccountActivityTargetInfo | null = null;
        if (r._id.kind === 'story_view' && r._id.targetId) {
          const storyId = String(r._id.targetId);
          const s: any = storyMap.get(storyId);
          target = {
            kind: 'story', id: storyId,
            imageUrl: s ? (s.media?.image?.url ?? s.media?.video?.poster ?? null) : null,
            href: `/u/${actor.username ?? actor.id}`, // opened via the story viewer, not a route — see AccountActivityRow
            available: Boolean(s),
          };
        } else if (r._id.kind === 'post_view' && r._id.targetId) {
          const updateId = String(r._id.targetId);
          const u: any = updateMap.get(updateId);
          target = {
            kind: 'post', id: updateId,
            imageUrl: u ? (u.media?.[0]?.image?.url ?? u.media?.[0]?.video?.poster ?? null) : null,
            href: `/post/${updateId}`,
            available: Boolean(u && u.status === 'active'),
          };
        }

        const group: AccountActivityGroup = {
          key: groupKey(r._id.actorType, actorId, r._id.kind, r._id.targetId ? String(r._id.targetId) : undefined),
          kind: r._id.kind,
          actor,
          target,
          count: r.count,
          lastAt: r.lastAt.toISOString(),
          unread: r.hasUnread === 1,
        };
        return group;
      })
      .filter((g): g is AccountActivityGroup => g !== null);

    return {
      items,
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.lastAt.toISOString() : null,
      unreadCount,
    };
  }

  /** Count of UNREAD groups (not raw events) — must agree with `list`'s
   *  `unread` flag so the badge and the tab never disagree on "is there
   *  something new". */
  static async unreadCount(ownerId: string): Promise<number> {
    const rows = await AccountActivityEvent.aggregate<{ _id: unknown }>([
      { $match: { ownerId: new Types.ObjectId(ownerId), readAt: null } },
      { $group: { _id: { actorType: '$actorType', actorId: '$actorId', kind: '$kind', targetId: '$targetId' } } },
      { $count: 'n' },
    ]);
    return (rows[0] as any)?.n ?? 0;
  }

  /** Mark one group read — every raw event that folds into it. */
  static async markRead(ownerId: string, group: { actorType: string; actorId: string; kind: string; targetId?: string }): Promise<void> {
    await AccountActivityEvent.updateMany(
      { ownerId, actorType: group.actorType, actorId: group.actorId, kind: group.kind, targetId: group.targetId ?? null, readAt: null },
      { $set: { readAt: new Date() } }
    );
  }

  static async markAllRead(ownerId: string): Promise<void> {
    await AccountActivityEvent.updateMany({ ownerId, readAt: null }, { $set: { readAt: new Date() } });
  }
}
