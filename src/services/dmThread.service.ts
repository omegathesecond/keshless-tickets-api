import mongoose from 'mongoose';
import { DmThread, IDmThread } from '@models/dmThread.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { Message } from '@models/message.model';
import { BlockService } from '@services/block.service';
import { DmEligibilityService } from '@services/dmEligibility.service';
import { HttpError } from '@utils/httpError.util';
import { toBuyerSummary, BuyerSummary } from '@utils/buyerSummary.util';
import { consumeToken } from '@utils/rateLimit.util';
import { assertNotSuspended } from '@utils/socialSuspension.util';
import type { SocialActor } from '@utils/socialActor.util';

const HEX24 = /^[0-9a-f]{24}$/i;

/** The organizer brand party of a brand↔buyer thread (never the phone/email). */
export interface OrganizerSummary { id: string; businessName: string; logoUrl: string | null }

export interface DmThreadView {
  id: string;
  isGroup: boolean;
  participants: BuyerSummary[]; // the OTHER buyer participants
  organizer?: OrganizerSummary | null; // set when the thread's other party is a brand
  lastMessageAt: Date | null;
  unreadCount: number;
}

export class DmThreadService {
  static pairKeyFor(idA: string, idB: string): string {
    const [lo, hi] = [idA, idB].sort();
    return `${lo}:${hi}`;
  }

  /**
   * The DM privacy gate. Any signed-in buyer may message any other buyer they
   * haven't blocked (or been blocked by) — no follow/meetup connection is
   * required (see DmEligibilityService).
   */
  static async assertCanDm(sender: IBuyer, target: IBuyer): Promise<void> {
    const senderId = String(sender._id);
    const targetId = String(target._id);

    if (!(await DmEligibilityService.canDm(senderId, targetId))) {
      throw new HttpError(403, 'You cannot message this user');
    }
  }

  static async openThread(creator: IBuyer, participantIds: string[]): Promise<IDmThread> {
    assertNotSuspended(creator);
    const creatorId = String(creator._id);
    // Lowercase before dedupe/pairKey: HEX24 accepts mixed case, but pairKey
    // dedupe and Mongo's unique index are case-sensitive.
    const otherIds = [...new Set(participantIds.map((id) => String(id).toLowerCase()))].filter(
      (id) => id !== creatorId
    );
    if (otherIds.length < 1 || otherIds.length > 9) {
      throw new HttpError(400, 'A conversation needs 1-9 other people');
    }

    // Groups never dedupe, so thread creation must be rate limited — the
    // same per-buyer budget as message sends.
    if (!consumeToken(`msg:${creatorId}`)) {
      throw new HttpError(429, 'You are doing that too quickly — slow down');
    }

    if (!otherIds.every((id) => HEX24.test(id))) {
      throw new HttpError(400, 'Invalid participant id');
    }

    const others = await Buyer.find({ _id: { $in: otherIds } });
    if (others.length !== otherIds.length) throw new HttpError(404, 'User not found');
    for (const other of others) {
      await DmThreadService.assertCanDm(creator, other);
    }

    if (otherIds.length === 1) {
      const pairKey = DmThreadService.pairKeyFor(creatorId, otherIds[0]!);
      const existing = await DmThread.findOne({ pairKey });
      if (existing) return existing;
      try {
        return await DmThread.create({
          participants: [creator._id, new mongoose.Types.ObjectId(otherIds[0]!)],
          isGroup: false,
          createdBy: creator._id,
          pairKey,
        });
      } catch (err: any) {
        if (err?.code === 11000) {
          const winner = await DmThread.findOne({ pairKey });
          if (winner) return winner;
        }
        throw err;
      }
    }

    return DmThread.create({
      participants: [creator._id, ...otherIds.map((id) => new mongoose.Types.ObjectId(id))],
      isGroup: true,
      createdBy: creator._id,
    });
  }

  /**
   * Brand-initiated 1:1 with a buyer. The buyer stays in `participants`, so
   * they see + reply to the thread through the unchanged buyer DM path;
   * `vendorParticipantId` marks the brand side. Deduped by `vendorPairKey`.
   */
  static async openVendorThread(vendorId: string, buyerId: string): Promise<IDmThread> {
    const bid = String(buyerId).toLowerCase();
    if (!HEX24.test(bid)) throw new HttpError(400, 'Invalid participant id');
    const buyer = await Buyer.findById(bid);
    if (!buyer) throw new HttpError(404, 'User not found');
    if (await BlockService.isBlockedEitherWay(vendorId, bid)) {
      throw new HttpError(403, 'You cannot message this user');
    }
    if (!consumeToken(`msg:v:${vendorId}`)) {
      throw new HttpError(429, 'You are doing that too quickly — slow down');
    }
    return DmThreadService.findOrCreateBrandBuyerThread(vendorId, bid);
  }

  /** The brand↔buyer thread shape, shared by BOTH open directions
   *  (brand-initiated openVendorThread + buyer-initiated openBuyerBrandThread):
   *  the buyer sits in `participants`, the brand in `vendorParticipantId`,
   *  deduped by the SAME vendorPairKey so the two directions collapse to one
   *  conversation rather than forking into two. */
  private static async findOrCreateBrandBuyerThread(vendorId: string, buyerId: string): Promise<IDmThread> {
    const vendorPairKey = `v:${vendorId}:${buyerId}`;
    const existing = await DmThread.findOne({ vendorPairKey });
    if (existing) return existing;
    try {
      return await DmThread.create({
        participants: [new mongoose.Types.ObjectId(buyerId)],
        vendorParticipantId: new mongoose.Types.ObjectId(vendorId),
        isGroup: false,
        createdBy: new mongoose.Types.ObjectId(buyerId), // createdBy ref is Buyer
        vendorPairKey,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        const winner = await DmThread.findOne({ vendorPairKey });
        if (winner) return winner;
      }
      throw err;
    }
  }

  /**
   * Buyer-initiated 1:1 with a brand — the mirror of openVendorThread, producing
   * the identical thread shape and the SAME vendorPairKey so a buyer-initiated
   * and a brand-initiated conversation dedupe to one thread. Block + suspension
   * gated; deliberately NO friend/meetup gate — a brand isn't a buyer, and
   * buyer→brand DMs are open (the public organizer page is the entry point).
   */
  static async openBuyerBrandThread(buyer: IBuyer, vendorId: string): Promise<IDmThread> {
    assertNotSuspended(buyer);
    const vid = String(vendorId).toLowerCase();
    if (!HEX24.test(vid)) throw new HttpError(400, 'Invalid organizer id');
    const buyerId = String(buyer._id);
    const vendor = await Vendor.findById(vid).select('isActive');
    if (!vendor || !vendor.isActive) throw new HttpError(404, 'Organizer not found');
    if (await BlockService.isBlockedEitherWay(vid, buyerId)) {
      throw new HttpError(403, 'You cannot message this organizer');
    }
    if (!consumeToken(`msg:${buyerId}`)) {
      throw new HttpError(429, 'You are doing that too quickly — slow down');
    }
    return DmThreadService.findOrCreateBrandBuyerThread(vid, buyerId);
  }

  /**
   * Brand↔brand 1:1 — a vendor opens (or reuses) a conversation with another
   * brand. No buyer party: both vendors live in `vendorParticipantIds`, deduped
   * order-independently by `brandPairKey`. Block-gated; a brand isn't suspended.
   */
  static async openBrandToBrandThread(actingVendorId: string, targetVendorId: string): Promise<IDmThread> {
    const a = String(actingVendorId).toLowerCase();
    const b = String(targetVendorId).toLowerCase();
    if (!HEX24.test(b)) throw new HttpError(400, 'Invalid organizer id');
    if (a === b) throw new HttpError(400, 'You cannot message yourself');
    const target = await Vendor.findById(b).select('isActive');
    if (!target || !target.isActive) throw new HttpError(404, 'Organizer not found');
    if (await BlockService.isBlockedEitherWay(a, b)) {
      throw new HttpError(403, 'You cannot message this organizer');
    }
    if (!consumeToken(`msg:v:${a}`)) {
      throw new HttpError(429, 'You are doing that too quickly — slow down');
    }
    return DmThreadService.findOrCreateBrandBrandThread(a, b);
  }

  /** Order-independent brand↔brand thread: `brandPairKey = vv:<lo>:<hi>` dedupes
   *  no matter which brand opened it. `participants` is empty (no buyer). */
  private static async findOrCreateBrandBrandThread(vendorIdA: string, vendorIdB: string): Promise<IDmThread> {
    const [lo, hi] = [vendorIdA, vendorIdB].sort();
    const brandPairKey = `vv:${lo}:${hi}`;
    const existing = await DmThread.findOne({ brandPairKey });
    if (existing) return existing;
    try {
      return await DmThread.create({
        participants: [],
        vendorParticipantIds: [new mongoose.Types.ObjectId(lo!), new mongoose.Types.ObjectId(hi!)],
        isGroup: false,
        brandPairKey,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        const winner = await DmThread.findOne({ brandPairKey });
        if (winner) return winner;
      }
      throw err;
    }
  }

  /** 404 on unknown/malformed/non-participant — never leak thread existence.
   *  Actor-aware: a buyer must be in `participants`; a vendor must be the
   *  thread's `vendorParticipantId`. */
  static async requireDmAccess(threadId: string, actor: SocialActor): Promise<IDmThread> {
    if (!HEX24.test(threadId)) throw new HttpError(404, 'Conversation not found');
    const thread = await DmThread.findById(threadId);
    if (!thread) throw new HttpError(404, 'Conversation not found');
    const isMember =
      actor.type === 'buyer'
        ? thread.participants.some((p) => String(p) === actor.id)
        : String(thread.vendorParticipantId ?? '') === actor.id ||
          (thread.vendorParticipantIds ?? []).some((v) => String(v) === actor.id);
    if (!isMember) throw new HttpError(404, 'Conversation not found');
    return thread;
  }

  static async buildThreadView(thread: IDmThread, actor: SocialActor): Promise<DmThreadView> {
    // For a buyer viewer, "others" are the other buyers; for a vendor viewer,
    // the buyer participants. A buyer viewing a brand thread also sees the
    // brand as `organizer`.
    const otherBuyerIds = thread.participants.filter((p) => actor.type !== 'buyer' || String(p) !== actor.id);
    const others = await Buyer.find({ _id: { $in: otherBuyerIds } });
    let organizer: OrganizerSummary | null = null;
    if (actor.type === 'buyer' && thread.vendorParticipantId) {
      const v = await Vendor.findById(thread.vendorParticipantId).select('businessName logoUrl');
      if (v) organizer = { id: String(v._id), businessName: v.businessName, logoUrl: v.logoUrl ?? null };
    } else if (actor.type === 'vendor' && thread.vendorParticipantIds?.length) {
      // Brand↔brand: the counterparty is the OTHER vendor in the pair.
      const otherId = thread.vendorParticipantIds.map(String).find((id) => id !== actor.id);
      if (otherId) {
        const v = await Vendor.findById(otherId).select('businessName logoUrl');
        if (v) organizer = { id: String(v._id), businessName: v.businessName, logoUrl: v.logoUrl ?? null };
      }
    }
    const since = thread.readState.get(actor.id) ?? thread.createdAt;
    const notMine =
      actor.type === 'buyer'
        ? { senderId: { $ne: new mongoose.Types.ObjectId(actor.id) } }
        : { senderVendorId: { $ne: new mongoose.Types.ObjectId(actor.id) } };
    const unreadCount = await Message.countDocuments(
      { dmThreadId: thread._id, createdAt: { $gt: since }, ...notMine },
      { limit: 99 }
    );
    return {
      id: String(thread._id),
      isGroup: thread.isGroup,
      participants: others.map(toBuyerSummary),
      organizer,
      lastMessageAt: thread.lastMessageAt ?? null,
      unreadCount,
    };
  }

  static async listThreads(actor: SocialActor): Promise<DmThreadView[]> {
    const query =
      actor.type === 'buyer'
        ? { participants: new mongoose.Types.ObjectId(actor.id) }
        : {
            // A brand's threads: brand↔buyer (vendorParticipantId) + brand↔brand
            // (vendorParticipantIds contains this brand).
            $or: [
              { vendorParticipantId: new mongoose.Types.ObjectId(actor.id) },
              { vendorParticipantIds: new mongoose.Types.ObjectId(actor.id) },
            ],
          };
    const threads = await DmThread.find(query).sort({ lastMessageAt: -1 }).limit(50);
    return Promise.all(threads.map((t) => DmThreadService.buildThreadView(t, actor)));
  }
}
