import { BlockService } from '@services/block.service';

/**
 * The ONE rule for opening a new buyer↔buyer conversation:
 *   canDm = !blockedEitherWay
 * Any signed-in buyer may message any other non-blocked buyer, connected or
 * not (a follow/meetup relationship is no longer required). Every surface
 * (assertCanDm, profile view, nearby, search) consumes this — do not
 * re-derive the block logic anywhere else.
 */
export class DmEligibilityService {
  /** Full gate for a single pair. */
  static async canDm(senderId: string, targetId: string): Promise<boolean> {
    return !(await BlockService.isBlockedEitherWay(senderId, targetId));
  }

  /** Batched: which of `otherIds` the viewer may DM. One pass for list surfaces. */
  static async canDmMap(viewerId: string, otherIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (otherIds.length === 0) return out;
    const [iBlocked, blockedMe] = await Promise.all([
      BlockService.listBlockedIds(viewerId),
      BlockService.listBlockerIds(viewerId),
    ]);
    const blocked = new Set([...iBlocked, ...blockedMe]);
    for (const id of otherIds) {
      if (!blocked.has(id)) out.add(id);
    }
    return out;
  }
}
