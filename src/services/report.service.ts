import { Report, IReport, ReportTargetType, ReportStatus } from '@models/report.model';
import { Message } from '@models/message.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Channel } from '@models/channel.model';
import { Community } from '@models/community.model';
import { Event } from '@models/event.model';
import { Update } from '@models/update.model';
import { Story } from '@models/story.model';
import { HttpError } from '@utils/httpError.util';
import { toBuyerSummary, BuyerSummary } from '@utils/buyerSummary.util';
import { consumeToken } from '@utils/rateLimit.util';
import { ModerationService } from '@services/moderation.service';

export type ReportResolveAction = 'delete_message' | 'suspend_buyer' | 'unsuspend_buyer' | 'dismiss';

/** Admin-only message context — deliberately NOT MessageService.toView: admins
 *  need the real body even for a deleted message (evidence), so this is a
 *  separate, unmasked shape. toView's masking must stay intact for every
 *  buyer-facing read — do not weaken it to serve this case. */
export interface ReportAdminMessageView {
  id: string;
  channelId: string;
  body: string;
  deleted: boolean;
  senderId: string | null;
  createdAt: Date;
  channelName: string | null;
  communityId: string | null;
  eventId: string | null;
  eventName: string | null;
}

export interface ReportAdminView {
  id: string;
  targetType: ReportTargetType;
  reason: string;
  status: ReportStatus;
  reporter: BuyerSummary;
  message: ReportAdminMessageView | null;
  targetBuyer: BuyerSummary | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}

export class ReportService {
  /**
   * POST /api/community/reports — buyer files a report. Rate-limited to a
   * burst of 3/min (same token-bucket util message sends use, own key
   * namespace). Dedupe is enforced at the DB (see report.model.ts's partial
   * unique indexes): a second open report on the same target from the same
   * reporter hits 11000 and we hand back the existing row instead of
   * throwing — the controller turns `created` into 201 vs 200.
   */
  static async fileReport(
    buyer: IBuyer,
    input: {
      targetType: ReportTargetType;
      messageId?: string;
      targetBuyerId?: string;
      targetUpdateId?: string;
      targetStoryId?: string;
      reason: string;
    }
  ): Promise<{ report: IReport; created: boolean }> {
    if (!consumeToken(`report:${String(buyer._id)}`, 3, 3 / 60)) {
      throw new HttpError(429, 'You are reporting too quickly — slow down');
    }

    if (input.targetType === 'message') {
      // Only CHANNEL messages are reportable — mirrors ModerationController's
      // "DM messages 404 here, organizers/admins never touch DMs" convention
      // (requireOwnedChannelMessage in moderation.controller.ts). The admin
      // view also needs channel/community/event context a DM message has none of.
      const message = await Message.findById(input.messageId);
      if (!message || !message.channelId) throw new HttpError(404, 'Message not found');
    } else if (input.targetType === 'buyer') {
      if (String(input.targetBuyerId) === String(buyer._id)) {
        throw new HttpError(400, 'You cannot report yourself');
      }
      const exists = await Buyer.exists({ _id: input.targetBuyerId });
      if (!exists) throw new HttpError(404, 'Buyer not found');
    } else if (input.targetType === 'story') {
      // Covers an inappropriate If I Go poll (question/custom options) or any
      // other Story — spec §16 "report inappropriate options, responses or
      // messages"; a reported response's private message is included in the
      // reason text since it isn't its own document.
      const exists = await Story.exists({ _id: input.targetStoryId });
      if (!exists) throw new HttpError(404, 'Story not found');
    } else {
      const exists = await Update.exists({ _id: input.targetUpdateId });
      if (!exists) throw new HttpError(404, 'Update not found');
    }

    try {
      const report = await Report.create({
        reporterId: buyer._id,
        targetType: input.targetType,
        messageId: input.targetType === 'message' ? input.messageId : undefined,
        targetBuyerId: input.targetType === 'buyer' ? input.targetBuyerId : undefined,
        targetUpdateId: input.targetType === 'update' ? input.targetUpdateId : undefined,
        targetStoryId: input.targetType === 'story' ? input.targetStoryId : undefined,
        reason: input.reason,
      });
      return { report, created: true };
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      const dedupeQuery: Record<string, unknown> = { reporterId: buyer._id, status: 'open' };
      if (input.targetType === 'message') dedupeQuery['messageId'] = input.messageId;
      else if (input.targetType === 'buyer') dedupeQuery['targetBuyerId'] = input.targetBuyerId;
      else if (input.targetType === 'story') dedupeQuery['targetStoryId'] = input.targetStoryId;
      else dedupeQuery['targetUpdateId'] = input.targetUpdateId;
      const existing = await Report.findOne(dedupeQuery);
      if (!existing) throw err; // shouldn't happen — surface rather than swallow
      return { report: existing, created: false };
    }
  }

  /** GET /api/tickets/reports?status=&before=&limit= — admin queue, defaults to 'open'. */
  static async listQueue(opts: {
    status?: ReportStatus;
    before?: string;
    limit?: number;
  }): Promise<ReportAdminView[]> {
    const status = opts.status ?? 'open';
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const query: Record<string, unknown> = { status };
    if (opts.before) query['_id'] = { $lt: opts.before };

    const reports = await Report.find(query).sort({ _id: -1 }).limit(limit);
    return Promise.all(reports.map((r) => ReportService.toAdminView(r)));
  }

  private static readonly RESOLVE_ACTIONS: ReportResolveAction[] = [
    'delete_message',
    'suspend_buyer',
    'unsuspend_buyer',
    'dismiss',
  ];

  /**
   * POST /api/tickets/reports/:reportId/resolve — every action sets
   * status/resolvedBy/resolvedAt (+ resolutionNote if given). Only 'open'
   * reports can be resolved (mirrors ReviewService's reply-once 409 shape).
   *
   * Atomic claim FIRST, side effects SECOND (same shape as TicketSale's
   * paymentStatus:PENDING claim in ticket.service.ts): findOneAndUpdate's
   * filter only matches while status is still 'open', so two concurrent
   * admins resolving the same report can never both pass — the loser's
   * write hits zero documents instead of racing the side effect against a
   * status write that lands after it. If the side effect throws post-claim
   * (e.g. the message a delete_message targets was hard-removed), the claim
   * is reverted back to 'open' so the report doesn't end up resolved with
   * no action actually taken.
   */
  static async resolve(
    reportId: string,
    actor: { userId?: string; vendorId: string },
    input: { action: ReportResolveAction; note?: string }
  ): Promise<ReportAdminView> {
    if (!ReportService.RESOLVE_ACTIONS.includes(input.action)) {
      throw new HttpError(400, 'Unknown action');
    }

    const targetStatus: ReportStatus = input.action === 'dismiss' ? 'dismissed' : 'resolved';
    const report = await Report.findOneAndUpdate(
      { _id: reportId, status: 'open' },
      {
        $set: {
          status: targetStatus,
          resolvedBy: actor.userId || actor.vendorId,
          resolvedAt: new Date(),
          resolutionNote: input.note ?? null,
        },
      },
      { new: true }
    );
    if (!report) {
      const exists = await Report.exists({ _id: reportId });
      throw new HttpError(exists ? 409 : 404, exists ? 'Report has already been resolved' : 'Report not found');
    }

    try {
      switch (input.action) {
        case 'delete_message':
          await ReportService.resolveDeleteMessage(report);
          break;
        case 'suspend_buyer':
          await ReportService.resolveSuspension(report, true);
          break;
        case 'unsuspend_buyer':
          await ReportService.resolveSuspension(report, false);
          break;
        case 'dismiss':
          break;
      }
    } catch (err) {
      await Report.updateOne(
        { _id: reportId },
        { $set: { status: 'open' }, $unset: { resolvedBy: 1, resolvedAt: 1, resolutionNote: 1 } }
      ).catch(() => undefined);
      throw err;
    }

    return ReportService.toAdminView(report);
  }

  /**
   * Reuses Task 2's ModerationService.deleteMessage (-> softDeleteChannelMessage)
   * unchanged — that method never did vendor-ownership itself (the
   * moderation CONTROLLER's requireOwnedChannelMessage walk does), so the
   * admin path calling it directly already skips the vendor walk. No fork of
   * the delete+broadcast logic needed.
   */
  private static async resolveDeleteMessage(report: IReport): Promise<void> {
    if (report.targetType !== 'message' || !report.messageId) {
      throw new HttpError(400, 'delete_message only applies to message reports');
    }
    const message = await Message.findById(report.messageId);
    if (!message || !message.channelId) throw new HttpError(404, 'Message not found');
    if (!message.deletedAt) {
      await ModerationService.deleteMessage(message);
    }
  }

  private static async resolveSuspension(report: IReport, suspend: boolean): Promise<void> {
    const offenderId = await ReportService.resolveOffenderId(report);
    if (!offenderId) throw new HttpError(400, 'Unable to determine the buyer to suspend');
    await Buyer.updateOne(
      { _id: offenderId },
      suspend ? { $set: { socialSuspendedAt: new Date() } } : { $set: { socialSuspendedAt: null } }
    );
  }

  /** The offender is the report's targetBuyerId, or a message report's sender
   *  (null when the message was organizer-authored — there's no buyer to suspend). */
  private static async resolveOffenderId(report: IReport): Promise<string | null> {
    if (report.targetType === 'buyer') return String(report.targetBuyerId);
    const message = await Message.findById(report.messageId).select('senderId');
    return message?.senderId ? String(message.senderId) : null;
  }

  private static async toAdminView(report: IReport): Promise<ReportAdminView> {
    const reporterDoc = await Buyer.findById(report.reporterId);
    const reporter: BuyerSummary = reporterDoc
      ? toBuyerSummary(reporterDoc)
      : { id: String(report.reporterId), username: null, name: null, avatarUrl: null };

    let message: ReportAdminMessageView | null = null;
    let targetBuyer: BuyerSummary | null = null;
    if (report.targetType === 'message') {
      message = await ReportService.buildAdminMessageView(report.messageId);
    } else {
      const targetDoc = await Buyer.findById(report.targetBuyerId);
      targetBuyer = targetDoc
        ? toBuyerSummary(targetDoc)
        : { id: String(report.targetBuyerId), username: null, name: null, avatarUrl: null };
    }

    return {
      id: String(report._id),
      targetType: report.targetType,
      reason: report.reason,
      status: report.status,
      reporter,
      message,
      targetBuyer,
      resolvedBy: report.resolvedBy ?? null,
      resolvedAt: report.resolvedAt ?? null,
      resolutionNote: report.resolutionNote ?? null,
      createdAt: report.createdAt,
    };
  }

  private static async buildAdminMessageView(messageId: unknown): Promise<ReportAdminMessageView | null> {
    const message = await Message.findById(messageId);
    if (!message || !message.channelId) return null; // shouldn't happen — messages are soft-deleted, never hard-removed
    const channel = await Channel.findById(message.channelId);
    const community = channel ? await Community.findById(channel.communityId) : null;
    const event = community ? await Event.findById(community.eventId).select('name') : null;

    return {
      id: String(message._id),
      channelId: String(message.channelId),
      body: message.body, // UNMASKED even when deletedAt is set — admins need evidence
      deleted: Boolean(message.deletedAt),
      senderId: message.senderId ? String(message.senderId) : null,
      createdAt: message.createdAt,
      channelName: channel?.name ?? null,
      communityId: community ? String(community._id) : null,
      eventId: community ? String(community.eventId) : null,
      eventName: (event as any)?.name ?? null,
    };
  }
}
