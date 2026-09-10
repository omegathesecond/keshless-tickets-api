import { EventPlanMessage, IEventPlanMessage } from '@models/eventPlanMessage.model';
import { EventPlanMessageReaction, PLAN_MESSAGE_REACTIONS, PlanMessageReactionEmoji } from '@models/eventPlanMessageReaction.model';
import { EventPlanMember } from '@models/eventPlanMember.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { EventPlanService } from '@services/eventPlan.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';

const displayName = (b: IBuyer): string => b.username ?? b.name ?? 'Someone';

export class EventPlanMessageService {
  /** Public plans: readable by anyone who can view the plan (spec §9 — "Public
   *  visitors may read... but cannot participate until they join"). Private
   *  plans: readable only by accepted members/admin, same as everything else. */
  static async list(planId: string, viewerId: string | null, before?: string, limit = 30): Promise<any[]> {
    const plan = await EventPlanService.loadForAccess(planId);
    const { canView } = await EventPlanService.accessFor(plan, viewerId);
    if (!canView) throw new HttpError(404, 'Plan not found');

    const filter: any = { planId, deletedAt: { $exists: false } };
    if (before) {
      if (!HEX24.test(before)) throw new HttpError(400, 'Invalid cursor');
      filter._id = { $lt: before };
    }
    const rows = await EventPlanMessage.find(filter)
      .sort({ _id: -1 })
      .limit(Math.min(Math.max(limit, 1), 100));

    return EventPlanMessageService.hydrate(rows.reverse());
  }

  private static async hydrate(rows: IEventPlanMessage[]): Promise<any[]> {
    if (rows.length === 0) return [];
    const senderIds = [...new Set(rows.map((r) => String(r.senderId)))];
    const senders = await Buyer.find({ _id: { $in: senderIds } }).select('name username avatarUrl');
    const senderById = new Map(senders.map((b: any) => [String(b._id), b]));

    const reactions = await EventPlanMessageReaction.find({ messageId: { $in: rows.map((r) => r._id) } });
    const reactionsByMessage = new Map<string, { emoji: string; buyerId: string }[]>();
    for (const r of reactions) {
      const key = String(r.messageId);
      const list = reactionsByMessage.get(key) ?? [];
      list.push({ emoji: r.emoji, buyerId: String(r.buyerId) });
      reactionsByMessage.set(key, list);
    }

    return rows.map((r) => {
      const sender = senderById.get(String(r.senderId));
      return {
        id: String(r._id),
        body: r.body,
        replyTo: r.replyTo ? String(r.replyTo) : null,
        sender: sender
          ? { id: String(sender._id), name: sender.name ?? null, username: sender.username ?? null, avatarUrl: sender.avatarUrl ?? null }
          : null,
        reactions: EventPlanMessageService.groupReactions(reactionsByMessage.get(String(r._id)) ?? []),
        createdAt: r.createdAt,
      };
    });
  }

  private static groupReactions(list: { emoji: string; buyerId: string }[]) {
    const byEmoji = new Map<string, string[]>();
    for (const { emoji, buyerId } of list) {
      const arr = byEmoji.get(emoji) ?? [];
      arr.push(buyerId);
      byEmoji.set(emoji, arr);
    }
    return [...byEmoji.entries()].map(([emoji, buyerIds]) => ({ emoji, count: buyerIds.length, buyerIds }));
  }

  static async send(sender: IBuyer, planId: string, body: string, replyTo?: string): Promise<any> {
    const plan = await EventPlanService.loadForAccess(planId);
    const senderId = String(sender._id);
    const { canParticipate } = await EventPlanService.accessFor(plan, senderId);
    if (!canParticipate) throw new HttpError(403, 'Join this plan to send messages');
    if (plan.status !== 'active') throw new HttpError(409, 'This plan is closed');

    const trimmed = (body || '').trim();
    if (!trimmed) throw new HttpError(400, 'Message cannot be empty');
    if (trimmed.length > 2000) throw new HttpError(400, 'Message is too long');
    if (replyTo && !HEX24.test(replyTo)) throw new HttpError(400, 'Invalid reply target');
    if (replyTo && !(await EventPlanMessage.exists({ _id: replyTo, planId }))) {
      throw new HttpError(404, 'The message you are replying to was not found');
    }

    const message = await EventPlanMessage.create({ planId, senderId: sender._id, body: trimmed, replyTo: replyTo || undefined });

    const memberIds = await EventPlanMessageService.otherAcceptedMemberIds(planId, senderId);
    if (memberIds.length > 0) {
      NotificationDispatcher.dispatchAsync(
        memberIds,
        'plan_message',
        displayName(sender),
        trimmed.length > 100 ? `${trimmed.slice(0, 97)}...` : trimmed,
        { planId: String(plan._id), eventId: String(plan.eventId), messageId: String(message._id) },
        senderId
      );
    }

    return (await EventPlanMessageService.hydrate([message]))[0];
  }

  private static async otherAcceptedMemberIds(planId: string, excludeId: string): Promise<string[]> {
    const rows = await EventPlanMember.find({ planId, status: 'accepted' }).select('buyerId');
    return rows.map((r) => String(r.buyerId)).filter((id) => id !== excludeId);
  }

  static async react(buyer: IBuyer, planId: string, messageId: string, emoji: string): Promise<void> {
    const plan = await EventPlanService.loadForAccess(planId);
    const buyerId = String(buyer._id);
    const { canParticipate } = await EventPlanService.accessFor(plan, buyerId);
    if (!canParticipate) throw new HttpError(403, 'Join this plan to react to messages');
    if (!HEX24.test(messageId)) throw new HttpError(400, 'Invalid message id');
    if (!PLAN_MESSAGE_REACTIONS.includes(emoji as PlanMessageReactionEmoji)) throw new HttpError(400, 'Unsupported reaction');
    const message = await EventPlanMessage.exists({ _id: messageId, planId });
    if (!message) throw new HttpError(404, 'Message not found');

    await EventPlanMessageReaction.findOneAndUpdate(
      { messageId, buyerId },
      { $set: { emoji, planId } },
      { upsert: true, new: true }
    );
  }

  static async unreact(buyer: IBuyer, planId: string, messageId: string): Promise<void> {
    const plan = await EventPlanService.loadForAccess(planId);
    const buyerId = String(buyer._id);
    const { canParticipate } = await EventPlanService.accessFor(plan, buyerId);
    if (!canParticipate) throw new HttpError(403, 'Join this plan to react to messages');
    if (!HEX24.test(messageId)) throw new HttpError(400, 'Invalid message id');
    await EventPlanMessageReaction.deleteOne({ messageId, buyerId });
  }
}
