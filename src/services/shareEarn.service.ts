import crypto from 'crypto';
import mongoose, { Types } from 'mongoose';
import { ShareEarnCampaign, IShareEarnCampaign } from '@models/shareEarnCampaign.model';
import { ShareEarnPromoter, IShareEarnPromoter } from '@models/shareEarnPromoter.model';
import { ShareEarnClick } from '@models/shareEarnClick.model';
import { ShareEarnReferral, IShareEarnReferral } from '@models/shareEarnReferral.model';
import { ShareEarnReward, IShareEarnReward } from '@models/shareEarnReward.model';
import { ShareEarnAuditLog } from '@models/shareEarnAuditLog.model';
import { ShareEarnPointsAward } from '@models/shareEarnPointsAward.model';
import { Event } from '@models/event.model';
import { Buyer } from '@models/buyer.model';
import { ITicketSale, ITicket } from '@interfaces/ticket.interface';
import { IShareEarnRewardRule, ShareEarnAuditAction } from '@interfaces/shareEarn.interface';
import { HttpError } from '@utils/httpError.util';
import { NotificationService } from '@services/notification.service';
import { PushService } from '@services/push.service';

const REPEAT_BUYER_FLAG_THRESHOLD = 2; // 2nd+ confirmed sale from the same buyer under one promoter gets flagged for review

function newRuleId(): string {
  return crypto.randomBytes(6).toString('hex');
}

function newReferralCode(): string {
  return crypto.randomBytes(5).toString('hex'); // 10 hex chars — short enough for a URL, long enough to not guess
}

async function log(
  campaignId: Types.ObjectId,
  eventId: Types.ObjectId,
  action: ShareEarnAuditAction,
  extra: {
    promoterId?: Types.ObjectId;
    referralId?: Types.ObjectId;
    rewardId?: Types.ObjectId;
    actorType: 'buyer' | 'vendor' | 'system';
    actorId?: Types.ObjectId;
    reason?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await ShareEarnAuditLog.create({ campaignId, eventId, action, ...extra });
  } catch (err) {
    console.error('[shareEarn] audit log write failed (non-fatal)', { action, err });
  }
}

async function requireOwnedCampaign(eventId: string, vendorId: string): Promise<IShareEarnCampaign> {
  const campaign = await ShareEarnCampaign.findOne({ eventId });
  if (!campaign) throw new HttpError(404, 'Share&Earn has not been set up for this event');
  if (String(campaign.vendorId) !== String(vendorId)) throw new HttpError(403, 'Not your event');
  return campaign;
}

/** Next un-awarded milestone (lowest threshold above the promoter's current count), or null. */
function nextMilestone(campaign: IShareEarnCampaign, promoter: IShareEarnPromoter): { rule: IShareEarnRewardRule; remaining: number } | null {
  const candidates = campaign.rewardRules
    .filter((r) => r.trigger === 'milestone' && !promoter.awardedMilestoneRuleIds.includes(r.ruleId))
    .sort((a, b) => (a.milestoneSalesCount ?? 0) - (b.milestoneSalesCount ?? 0));
  const rule = candidates[0];
  if (!rule) return null;
  return { rule, remaining: Math.max(0, (rule.milestoneSalesCount ?? 0) - promoter.confirmedSalesCount) };
}

/** All-time Share&Earn points for a buyer — same persisted-ledger pattern as totalStoryPoints (see storyPoints.service). Folded into the buyer's points balance alongside post/ticket/story points. */
export async function totalShareEarnPoints(buyerId: Types.ObjectId | string): Promise<number> {
  const id = typeof buyerId === 'string' ? new Types.ObjectId(buyerId) : buyerId;
  const rows = await ShareEarnPointsAward.aggregate<{ _id: null; total: number }>([
    { $match: { buyerId: id } },
    { $group: { _id: null, total: { $sum: '$points' } } },
  ]);
  return rows[0]?.total ?? 0;
}

export class ShareEarnService {
  // ───────────────────────── Organizer: campaign config ─────────────────────

  static async getCampaign(eventId: string, vendorId: string): Promise<IShareEarnCampaign | null> {
    const campaign = await ShareEarnCampaign.findOne({ eventId });
    if (campaign && String(campaign.vendorId) !== String(vendorId)) throw new HttpError(403, 'Not your event');
    return campaign;
  }

  /**
   * Create or update the DRAFT reward structure. Once the campaign has ever
   * been activated, an update may only ADD reward rules or raise limits —
   * never shrink/remove a rule a promoter may already have qualifying sales
   * against (spec §1: "do not reduce or negatively change rewards for
   * promoters who have already generated qualifying sales"). We enforce this
   * narrowly: any existing ruleId's pointsAmount/costValue may not DECREASE,
   * and no existing ruleId may be removed, once the campaign has left draft.
   */
  static async upsertCampaign(
    eventId: string,
    vendor: { _id: Types.ObjectId },
    payload: {
      startsAt: string | Date;
      endsAt: string | Date;
      eligibleTicketTypeIds?: string[];
      rewardRules: Array<Omit<IShareEarnRewardRule, 'ruleId'> & { ruleId?: string }>;
      maxPromoters?: number | null;
      maxRewardBudget?: number | null;
      allowSelfReferral?: boolean;
      showLeaderboard?: boolean;
      requirePromoterApproval?: boolean;
      terms?: string;
    }
  ): Promise<IShareEarnCampaign> {
    const event = await Event.findById(eventId).select('vendorId');
    if (!event) throw new HttpError(404, 'Event not found');
    if (String(event.vendorId) !== String(vendor._id)) throw new HttpError(403, 'Not your event');

    const startsAt = new Date(payload.startsAt);
    const endsAt = new Date(payload.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      throw new HttpError(400, 'Campaign closing date must be after the starting date');
    }
    if (!payload.rewardRules?.length) {
      throw new HttpError(400, 'Configure at least one reward before activating Share&Earn');
    }
    for (const rule of payload.rewardRules) {
      if (rule.trigger === 'milestone' && !(rule.milestoneSalesCount && rule.milestoneSalesCount > 0)) {
        throw new HttpError(400, 'Every milestone reward needs a positive sales-count target');
      }
      if (rule.rewardType === 'points' && !(rule.pointsAmount && rule.pointsAmount > 0)) {
        throw new HttpError(400, 'A points reward needs a positive points amount');
      }
    }

    let campaign = await ShareEarnCampaign.findOne({ eventId });
    const rewardRules: IShareEarnRewardRule[] = payload.rewardRules.map((r) => ({ ...r, ruleId: r.ruleId || newRuleId() }));

    if (!campaign) {
      campaign = await ShareEarnCampaign.create({
        eventId,
        vendorId: vendor._id,
        status: 'draft',
        startsAt,
        endsAt,
        eligibleTicketTypeIds: payload.eligibleTicketTypeIds ?? [],
        rewardRules,
        maxPromoters: payload.maxPromoters ?? undefined,
        maxRewardBudget: payload.maxRewardBudget ?? undefined,
        allowSelfReferral: !!payload.allowSelfReferral,
        showLeaderboard: payload.showLeaderboard !== false,
        requirePromoterApproval: !!payload.requirePromoterApproval,
        terms: payload.terms,
        createdBy: vendor._id,
      });
      await log(campaign._id as Types.ObjectId, campaign.eventId, 'campaign_created', { actorType: 'vendor', actorId: vendor._id });
      return campaign;
    }

    if (campaign.status !== 'draft') {
      const existingById = new Map(campaign.rewardRules.map((r) => [r.ruleId, r]));
      for (const [ruleId, existing] of existingById) {
        const incoming = rewardRules.find((r) => r.ruleId === ruleId);
        if (!incoming) throw new HttpError(400, 'Cannot remove a reward that promoters may have already qualified for once Share&Earn is active');
        if ((incoming.pointsAmount ?? 0) < (existing.pointsAmount ?? 0)) {
          throw new HttpError(400, 'Cannot reduce a reward already earned by promoters');
        }
        if ((incoming.costValue ?? 0) < (existing.costValue ?? 0)) {
          throw new HttpError(400, 'Cannot reduce a reward already earned by promoters');
        }
      }
      if (payload.maxPromoters != null && campaign.maxPromoters != null && payload.maxPromoters < campaign.maxPromoters) {
        throw new HttpError(400, 'Cannot lower the promoter cap below its current value once active');
      }
      if (endsAt < campaign.endsAt) {
        throw new HttpError(400, 'Cannot move the closing date earlier once active');
      }
    }

    campaign.startsAt = startsAt;
    campaign.endsAt = endsAt;
    campaign.eligibleTicketTypeIds = payload.eligibleTicketTypeIds ?? campaign.eligibleTicketTypeIds;
    campaign.rewardRules = rewardRules;
    campaign.maxPromoters = payload.maxPromoters ?? campaign.maxPromoters;
    campaign.maxRewardBudget = payload.maxRewardBudget ?? campaign.maxRewardBudget;
    campaign.allowSelfReferral = payload.allowSelfReferral ?? campaign.allowSelfReferral;
    campaign.showLeaderboard = payload.showLeaderboard ?? campaign.showLeaderboard;
    campaign.requirePromoterApproval = payload.requirePromoterApproval ?? campaign.requirePromoterApproval;
    campaign.terms = payload.terms ?? campaign.terms;
    campaign.updatedBy = vendor._id;
    await campaign.save();
    await log(campaign._id as Types.ObjectId, campaign.eventId, 'campaign_updated', { actorType: 'vendor', actorId: vendor._id });
    return campaign;
  }

  static async activateCampaign(eventId: string, vendorId: string): Promise<IShareEarnCampaign> {
    const campaign = await requireOwnedCampaign(eventId, vendorId);
    if (campaign.status === 'active') return campaign;
    if (campaign.status === 'closed') throw new HttpError(400, 'This campaign has closed and cannot be reactivated');
    if (new Date() >= campaign.endsAt) throw new HttpError(400, 'The closing date has already passed — update it before activating');
    campaign.status = 'active';
    campaign.activatedAt = campaign.activatedAt ?? new Date();
    await campaign.save();
    await log(campaign._id as Types.ObjectId, campaign.eventId, 'campaign_activated', { actorType: 'vendor', actorId: new Types.ObjectId(vendorId) });
    return campaign;
  }

  static async pauseCampaign(eventId: string, vendorId: string): Promise<IShareEarnCampaign> {
    const campaign = await requireOwnedCampaign(eventId, vendorId);
    if (campaign.status !== 'active') throw new HttpError(400, 'Only an active campaign can be paused');
    campaign.status = 'paused';
    campaign.pausedAt = new Date();
    await campaign.save();
    await log(campaign._id as Types.ObjectId, campaign.eventId, 'campaign_paused', { actorType: 'vendor', actorId: new Types.ObjectId(vendorId) });
    return campaign;
  }

  static async setRegistrationsPaused(eventId: string, vendorId: string, paused: boolean): Promise<IShareEarnCampaign> {
    const campaign = await requireOwnedCampaign(eventId, vendorId);
    campaign.registrationsPaused = paused;
    await campaign.save();
    await log(
      campaign._id as Types.ObjectId,
      campaign.eventId,
      paused ? 'campaign_registrations_paused' : 'campaign_registrations_resumed',
      { actorType: 'vendor', actorId: new Types.ObjectId(vendorId) }
    );
    return campaign;
  }

  /**
   * Close a campaign — stop new referrals, preserve everything earned so far
   * (spec §17). Pending rewards are left exactly as they are: 'pending'
   * per-sale rewards still confirm normally as their sale finalizes (a sale
   * already in flight when the campaign closes should not lose its
   * promoter's reward), but no NEW referral may attach after closedAt.
   */
  static async closeCampaign(eventId: string, vendorId: string): Promise<IShareEarnCampaign> {
    const campaign = await requireOwnedCampaign(eventId, vendorId);
    if (campaign.status === 'closed') return campaign;
    campaign.status = 'closed';
    campaign.closedAt = new Date();
    await campaign.save();
    await log(campaign._id as Types.ObjectId, campaign.eventId, 'campaign_closed', { actorType: 'vendor', actorId: new Types.ObjectId(vendorId) });
    return campaign;
  }

  /** Background sweep — mirrors the codebase's other reminder/expiry sweeps (@/tasks/backgroundTasks). */
  static async autoCloseExpiredCampaigns(): Promise<number> {
    const res = await ShareEarnCampaign.updateMany(
      { status: { $in: ['active', 'paused'] }, endsAt: { $lte: new Date() } },
      { $set: { status: 'closed', closedAt: new Date() } }
    );
    return res.modifiedCount ?? 0;
  }

  // ───────────────────────── Organizer: dashboard ───────────────────────────

  static async getDashboard(eventId: string, vendorId: string) {
    const campaign = await requireOwnedCampaign(eventId, vendorId);
    const campaignId = campaign._id;

    const [promoterCount, clickAgg, saleAgg, rewardAgg, topPromoters] = await Promise.all([
      ShareEarnPromoter.countDocuments({ campaignId }),
      ShareEarnClick.aggregate([
        { $match: { campaignId } },
        { $group: { _id: null, clicks: { $sum: 1 }, visitors: { $addToSet: '$visitorKey' } } },
      ]),
      ShareEarnReferral.aggregate([
        { $match: { campaignId, status: 'confirmed' } },
        { $group: { _id: null, tickets: { $sum: '$eligibleTicketCount' }, revenue: { $sum: '$eligibleSalesValue' } } },
      ]),
      ShareEarnReward.aggregate([
        { $match: { campaignId } },
        { $group: { _id: '$status', count: { $sum: 1 }, cost: { $sum: '$costValue' } } },
      ]),
      ShareEarnPromoter.find({ campaignId }).sort({ confirmedSalesCount: -1 }).limit(10)
        .populate('buyerId', 'name username avatarUrl'),
    ]);

    const clicks = clickAgg[0]?.clicks ?? 0;
    const uniqueVisitors = clickAgg[0]?.visitors?.length ?? 0;
    const ticketsSold = saleAgg[0]?.tickets ?? 0;
    const revenue = saleAgg[0]?.revenue ?? 0;

    const rewardsByStatus: Record<string, { count: number; cost: number }> = {};
    let totalCost = 0;
    for (const row of rewardAgg) {
      rewardsByStatus[row._id] = { count: row.count, cost: row.cost };
      if (row._id !== 'reversed') totalCost += row.cost;
    }

    return {
      campaign: ShareEarnService.toOrganizerCampaignView(campaign),
      registeredPromoters: promoterCount,
      linkClicks: clicks,
      uniqueVisitors,
      ticketSalesGenerated: ticketsSold,
      revenueGenerated: revenue,
      pendingRewards: rewardsByStatus['pending']?.count ?? 0,
      confirmedRewards: (rewardsByStatus['confirmed']?.count ?? 0) + (rewardsByStatus['available']?.count ?? 0),
      redeemedRewards: rewardsByStatus['redeemed']?.count ?? 0,
      totalCampaignRewardCost: totalCost,
      conversionRate: clicks > 0 ? Number(((ticketsSold / clicks) * 100).toFixed(2)) : 0,
      remainingRewardBudget: campaign.maxRewardBudget != null ? Math.max(0, campaign.maxRewardBudget - campaign.rewardBudgetSpent) : null,
      topPromoters: topPromoters.map((p: any) => ({
        promoterId: String(p._id),
        buyer: p.buyerId ? { id: String(p.buyerId._id), name: p.buyerId.name, username: p.buyerId.username, avatarUrl: p.buyerId.avatarUrl } : null,
        confirmedSalesCount: p.confirmedSalesCount,
        ticketsSoldCount: p.ticketsSoldCount,
      })),
    };
  }

  static async listPromoters(eventId: string, vendorId: string, page = 1, limit = 50) {
    const campaign = await requireOwnedCampaign(eventId, vendorId);
    const skip = Math.max(0, (page - 1) * limit);
    const [rows, total] = await Promise.all([
      ShareEarnPromoter.find({ campaignId: campaign._id }).sort({ confirmedSalesCount: -1, _id: -1 }).skip(skip).limit(limit)
        .populate('buyerId', 'name username avatarUrl phone email'),
      ShareEarnPromoter.countDocuments({ campaignId: campaign._id }),
    ]);
    return {
      total,
      page,
      limit,
      promoters: rows.map((p: any) => ShareEarnService.toPromoterAdminView(p)),
    };
  }

  static async listFlaggedReferrals(eventId: string, vendorId: string) {
    const campaign = await requireOwnedCampaign(eventId, vendorId);
    const rows = await ShareEarnReferral.find({ campaignId: campaign._id, flagged: true, status: { $in: ['pending', 'confirmed'] } })
      .sort({ _id: -1 })
      .populate({ path: 'promoterId', populate: { path: 'buyerId', select: 'name username avatarUrl' } })
      .populate('buyerId', 'name username avatarUrl');
    return rows.map((r: any) => ({
      id: String(r._id),
      status: r.status,
      flaggedReason: r.flaggedReason,
      eligibleTicketCount: r.eligibleTicketCount,
      eligibleSalesValue: r.eligibleSalesValue,
      createdAt: r.createdAt,
      promoter: r.promoterId?.buyerId ? { id: String(r.promoterId._id), buyerName: r.promoterId.buyerId.name, username: r.promoterId.buyerId.username } : null,
      referredBuyer: r.buyerId ? { id: String(r.buyerId._id), name: r.buyerId.name, username: r.buyerId.username } : null,
    }));
  }

  /**
   * Organizer review of a flagged (or any) referral — approve confirms it
   * (issuing rewards, same path a clean sale takes) or disqualify reverses it
   * with a recorded, auditable reason (spec §10/§16). Never silently drops a
   * legitimate sale: disqualifying always requires `reason`.
   */
  static async reviewReferral(eventId: string, vendorId: string, referralId: string, action: 'approve' | 'disqualify', reason: string | undefined, vendorObjId: Types.ObjectId) {
    const campaign = await requireOwnedCampaign(eventId, vendorId);
    const referral = await ShareEarnReferral.findOne({ _id: referralId, campaignId: campaign._id });
    if (!referral) throw new HttpError(404, 'Referral not found');

    if (action === 'disqualify') {
      if (!reason?.trim()) throw new HttpError(400, 'A reason is required to disqualify a referral');
      return ShareEarnService.disqualifyReferral(referral, campaign, reason.trim(), vendorObjId);
    }

    if (referral.status === 'confirmed') { referral.flagged = false; await referral.save(); return referral; }
    if (referral.status !== 'pending') throw new HttpError(400, `Referral is already ${referral.status}`);
    referral.flagged = false;
    await referral.save();
    return ShareEarnService.confirmReferral(referral, campaign, { forceApproved: true });
  }

  static async disqualifyReferral(referral: IShareEarnReferral, campaign: IShareEarnCampaign, reason: string, vendorId: Types.ObjectId) {
    if (referral.status === 'disqualified' || referral.status === 'reversed') return referral;
    const wasConfirmed = referral.status === 'confirmed';
    referral.status = 'disqualified';
    referral.disqualifiedAt = new Date();
    referral.disqualifiedReason = reason;
    referral.disqualifiedBy = vendorId;
    await referral.save();
    await log(campaign._id as Types.ObjectId, campaign.eventId, 'referral_disqualified', {
      referralId: referral._id as Types.ObjectId, promoterId: referral.promoterId, actorType: 'vendor', actorId: vendorId, reason,
    });
    if (wasConfirmed) await ShareEarnService.reverseRewardsForReferral(referral, campaign, reason);
    return referral;
  }

  static async exportCampaignCsv(eventId: string, vendorId: string): Promise<string> {
    const campaign = await requireOwnedCampaign(eventId, vendorId);
    const promoters = await ShareEarnPromoter.find({ campaignId: campaign._id }).sort({ confirmedSalesCount: -1 })
      .populate('buyerId', 'name username phone email');
    const header = ['Promoter', 'Username', 'Phone', 'Email', 'Referral Code', 'Clicks', 'Unique Visitors', 'Confirmed Sales', 'Tickets Sold', 'Eligible Sales Value', 'Pending Rewards', 'Confirmed Rewards', 'Redeemed Rewards', 'Status'];
    const rows = promoters.map((p: any) => [
      p.buyerId?.name ?? '', p.buyerId?.username ?? '', p.buyerId?.phone ?? '', p.buyerId?.email ?? '',
      p.referralCode, p.clicks, p.uniqueVisitors, p.confirmedSalesCount, p.ticketsSoldCount, p.eligibleSalesValue.toFixed(2),
      p.pendingRewardsCount, p.confirmedRewardsCount, p.redeemedRewardsCount, p.status,
    ]);
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    return [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  }

  // ───────────────────────── Buyer: discover + join ─────────────────────────

  static async getPublicCampaign(eventId: string, viewerBuyerId?: string) {
    const campaign = await ShareEarnCampaign.findOne({ eventId, status: { $in: ['active', 'paused'] } });
    if (!campaign) return null;
    let joined: IShareEarnPromoter | null = null;
    if (viewerBuyerId) joined = await ShareEarnPromoter.findOne({ campaignId: campaign._id, buyerId: viewerBuyerId });
    return {
      campaign: ShareEarnService.toPublicCampaignView(campaign),
      joined: joined ? ShareEarnService.toPromoterBuyerView(joined, campaign) : null,
    };
  }

  static async joinCampaign(eventId: string, buyer: { _id: Types.ObjectId }) {
    const campaign = await ShareEarnCampaign.findOne({ eventId });
    if (!campaign || campaign.status !== 'active') throw new HttpError(400, 'Share&Earn is not open for this event right now');
    if (campaign.registrationsPaused) throw new HttpError(400, 'Share&Earn is not accepting new promoters right now');
    if (new Date() >= campaign.endsAt) throw new HttpError(400, 'This Share&Earn campaign has closed');
    if (campaign.maxPromoters) {
      const count = await ShareEarnPromoter.countDocuments({ campaignId: campaign._id });
      if (count >= campaign.maxPromoters) throw new HttpError(400, 'This campaign has reached its maximum number of promoters');
    }

    const existing = await ShareEarnPromoter.findOne({ campaignId: campaign._id, buyerId: buyer._id });
    if (existing) return { promoter: existing, campaign };

    let promoter: IShareEarnPromoter | null = null;
    for (let attempt = 0; attempt < 5 && !promoter; attempt++) {
      try {
        promoter = await ShareEarnPromoter.create({
          campaignId: campaign._id,
          eventId: campaign.eventId,
          buyerId: buyer._id,
          referralCode: newReferralCode(),
          status: campaign.requirePromoterApproval ? 'pending_approval' : 'active',
          joinedAt: new Date(),
          ...(campaign.requirePromoterApproval ? {} : { approvedAt: new Date() }),
        });
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
        if (String(err?.keyPattern?.buyerId) === '1') {
          const race = await ShareEarnPromoter.findOne({ campaignId: campaign._id, buyerId: buyer._id });
          if (race) return { promoter: race, campaign };
        }
        // referralCode collision (astronomically unlikely) — retry with a fresh code
      }
    }
    if (!promoter) throw new HttpError(500, 'Could not generate a referral code — please try again');

    await log(campaign._id as Types.ObjectId, campaign.eventId, 'promoter_joined', { promoterId: promoter._id as Types.ObjectId, actorType: 'buyer', actorId: buyer._id });

    if (promoter.status === 'active') {
      NotificationService.create('buyer', String(buyer._id), 'share_earn_joined',
        'You joined Share&Earn', 'Start sharing your link to earn rewards from confirmed ticket sales.',
        { shareEarnCampaignId: String(campaign._id), shareEarnPromoterId: String(promoter._id) })
        .catch((e) => console.error('[shareEarn] join notification failed', e));
    }

    return { promoter, campaign };
  }

  static async setLeaderboardOptOut(buyer: { _id: Types.ObjectId }, promoterId: string, optOut: boolean) {
    const promoter = await ShareEarnPromoter.findOne({ _id: promoterId, buyerId: buyer._id });
    if (!promoter) throw new HttpError(404, 'Not found');
    promoter.optOutLeaderboard = optOut;
    await promoter.save();
    return promoter;
  }

  // ───────────────────────── Buyer: sharing + tracking ───────────────────────

  static async trackClick(referralCode: string, visitorKey: string, meta: { ip?: string; userAgent?: string }) {
    const promoter = await ShareEarnPromoter.findOne({ referralCode });
    if (!promoter) return null;
    const campaign = await ShareEarnCampaign.findById(promoter.campaignId);
    if (!campaign || !['active', 'paused'].includes(campaign.status)) return null;

    const isNewVisitor = visitorKey ? !(await ShareEarnClick.exists({ promoterId: promoter._id, visitorKey })) : false;
    await ShareEarnClick.create({ campaignId: campaign._id, promoterId: promoter._id, visitorKey: visitorKey || 'unknown', ...meta });
    promoter.clicks += 1;
    if (isNewVisitor) promoter.uniqueVisitors += 1;
    await promoter.save();

    const event = await Event.findById(campaign.eventId).select('eventId name');
    return { eventId: event?.eventId, eventMongoId: String(campaign.eventId) };
  }

  static async resolveReferralCode(referralCode: string) {
    const promoter = await ShareEarnPromoter.findOne({ referralCode });
    if (!promoter) return null;
    const campaign = await ShareEarnCampaign.findById(promoter.campaignId);
    if (!campaign) return null;
    const event = await Event.findById(campaign.eventId).select('eventId name');
    return { eventId: event?.eventId, eventMongoId: String(campaign.eventId), eventName: event?.name };
  }

  // ───────────────────────── Sale lifecycle hooks ────────────────────────────
  // Called from TicketService — see ticket.service.ts. Kept intentionally
  // defensive (never throws into the caller's checkout/finalize path): a
  // Share&Earn bug must never break a ticket purchase.

  /**
   * Attach a pending referral to a just-created sale (before payment
   * confirms — see ITicketSale.shareEarnReferralCode, set by the caller at
   * sale-creation time). No-ops quietly on any invalid/expired/self-referral
   * condition rather than failing the sale — the buyer still gets their
   * ticket; they just don't credit a promoter.
   */
  static async registerPendingReferral(sale: ITicketSale): Promise<void> {
    const code = sale.shareEarnReferralCode;
    if (!code) return;
    try {
      const promoter = await ShareEarnPromoter.findOne({ referralCode: code });
      if (!promoter || promoter.status === 'disqualified') return;
      const campaign = await ShareEarnCampaign.findById(promoter.campaignId);
      if (!campaign || campaign.status !== 'active') return;
      const now = new Date();
      if (now < campaign.startsAt || now >= campaign.endsAt) return;

      const eligibleIds = campaign.eligibleTicketTypeIds;
      const lines = sale.lines ?? [];
      const eligibleLines = eligibleIds.length ? lines.filter((l) => eligibleIds.includes(l.ticketTypeId)) : lines;
      if (lines.length && !eligibleLines.length) return; // sale has line detail and none of it qualifies

      const isSelf = sale.buyerId && String(sale.buyerId) === String(promoter.buyerId);
      if (isSelf && !campaign.allowSelfReferral) return;

      await ShareEarnReferral.create({
        campaignId: campaign._id,
        eventId: campaign.eventId,
        promoterId: promoter._id,
        buyerId: sale.buyerId,
        ticketSaleId: sale._id,
        status: 'pending',
      });
      promoter.checkoutAttempts += 1;
      await promoter.save();
      await log(campaign._id as Types.ObjectId, campaign.eventId, 'referral_attributed', {
        promoterId: promoter._id as Types.ObjectId, actorType: 'system', metadata: { saleId: String(sale._id) },
      });
    } catch (err: any) {
      if (err?.code === 11000) return; // sale already claimed by a referral (shouldn't happen — one code path per sale) — no-op
      console.error('[shareEarn] registerPendingReferral failed (non-fatal)', err);
    }
  }

  /** Called once a sale is COMPLETED and tickets are minted. */
  static async confirmReferralForSale(sale: ITicketSale): Promise<void> {
    try {
      const referral = await ShareEarnReferral.findOne({ ticketSaleId: sale._id, status: 'pending' });
      if (!referral) return;
      const campaign = await ShareEarnCampaign.findById(referral.campaignId);
      if (!campaign) return;

      const eligibleIds = campaign.eligibleTicketTypeIds;
      const lines = sale.lines ?? [];
      const eligibleLines = eligibleIds.length ? lines.filter((l) => eligibleIds.includes(l.ticketTypeId)) : lines;
      const ticketCount = eligibleLines.length ? eligibleLines.reduce((s, l) => s + l.quantity, 0) : sale.quantity;
      const salesValue = eligibleLines.length ? eligibleLines.reduce((s, l) => s + l.unitPrice * l.quantity, 0) : sale.totalAmount;
      referral.eligibleTicketCount = ticketCount;
      referral.eligibleSalesValue = salesValue;

      // Fraud signal (spec §16): the same purchaser buying repeatedly through
      // one promoter's link is flagged for organizer review rather than
      // auto-rewarded — could be legitimate (a friend buying for a group over
      // several visits) or self-dealing via a second account.
      if (sale.buyerId) {
        const priorFromSameBuyer = await ShareEarnReferral.countDocuments({
          promoterId: referral.promoterId, buyerId: sale.buyerId, status: 'confirmed',
        });
        if (priorFromSameBuyer >= REPEAT_BUYER_FLAG_THRESHOLD - 1) {
          referral.flagged = true;
          referral.flaggedReason = 'Repeated purchases from the same buyer under one promoter';
          await referral.save();
          await log(campaign._id as Types.ObjectId, campaign.eventId, 'referral_flagged', {
            referralId: referral._id as Types.ObjectId, promoterId: referral.promoterId, actorType: 'system', reason: referral.flaggedReason,
          });
          return; // held for organizer review — see reviewReferral
        }
      }
      await referral.save();
      await ShareEarnService.confirmReferral(referral, campaign, {});
    } catch (err) {
      console.error('[shareEarn] confirmReferralForSale failed (non-fatal)', err);
    }
  }

  private static async confirmReferral(referral: IShareEarnReferral, campaign: IShareEarnCampaign, _opts: { forceApproved?: boolean }): Promise<void> {
    referral.status = 'confirmed';
    referral.confirmedAt = new Date();
    await referral.save();
    await log(campaign._id as Types.ObjectId, campaign.eventId, 'referral_confirmed', {
      referralId: referral._id as Types.ObjectId, promoterId: referral.promoterId, actorType: 'system',
    });

    const promoter = await ShareEarnPromoter.findById(referral.promoterId);
    if (!promoter) return;
    promoter.confirmedSalesCount += 1;
    promoter.ticketsSoldCount += referral.eligibleTicketCount;
    promoter.eligibleSalesValue += referral.eligibleSalesValue;

    const buyer = await Buyer.findById(promoter.buyerId).select('_id');
    if (!buyer) { await promoter.save(); return; }

    // Per-sale reward(s) — every rule with trigger='per_sale'.
    for (const rule of campaign.rewardRules.filter((r) => r.trigger === 'per_sale')) {
      await ShareEarnService.issueReward(campaign, promoter, rule, { sourceReferralId: referral._id as Types.ObjectId });
    }

    // Milestone rewards reached by this confirmation.
    for (const rule of campaign.rewardRules.filter((r) => r.trigger === 'milestone')) {
      if (promoter.awardedMilestoneRuleIds.includes(rule.ruleId)) continue;
      if (promoter.confirmedSalesCount >= (rule.milestoneSalesCount ?? Infinity)) {
        promoter.awardedMilestoneRuleIds.push(rule.ruleId);
        await ShareEarnService.issueReward(campaign, promoter, rule, { milestoneSalesCount: rule.milestoneSalesCount });
      }
    }

    await promoter.save();

    NotificationService.create('buyer', String(promoter.buyerId), 'share_earn_sale_confirmed',
      'Referral sale confirmed', 'A ticket sale you referred just confirmed — check your rewards in My Share&Earn.',
      { shareEarnCampaignId: String(campaign._id), shareEarnPromoterId: String(promoter._id), shareEarnReferralId: String(referral._id) })
      .catch((e) => console.error('[shareEarn] sale-confirmed notification failed', e));
    PushService.sendToBuyer(String(promoter.buyerId), {
      title: 'Referral sale confirmed', body: 'Someone bought a ticket through your Share&Earn link.',
      data: { type: 'share_earn_referral_confirmed', campaignId: String(campaign._id) },
    }).catch((e) => console.error('[shareEarn] push failed', e));
  }

  private static async issueReward(
    campaign: IShareEarnCampaign,
    promoter: IShareEarnPromoter,
    rule: IShareEarnRewardRule,
    extra: { sourceReferralId?: Types.ObjectId; milestoneSalesCount?: number }
  ): Promise<IShareEarnReward | null> {
    if (campaign.maxRewardBudget != null && rule.costValue) {
      if (campaign.rewardBudgetSpent + rule.costValue > campaign.maxRewardBudget) {
        console.warn('[shareEarn] reward budget exhausted — skipping issue', { campaignId: String(campaign._id), ruleId: rule.ruleId });
        return null;
      }
    }

    // Non-points rewards from the ORGANIZER need their fulfilment confirmed
    // before a promoter can redeem them (spec §10 "confirm eligible rewards
    // where approval is required"); Carrot-provided rewards and all points
    // rewards are immediately usable.
    const needsApproval = rule.rewardType !== 'points' && rule.provider === 'organizer';
    const now = new Date();

    let reward: IShareEarnReward;
    try {
      reward = await ShareEarnReward.create({
        campaignId: campaign._id,
        eventId: campaign.eventId,
        promoterId: promoter._id,
        buyerId: promoter.buyerId,
        ruleId: rule.ruleId,
        trigger: rule.trigger,
        rewardType: rule.rewardType,
        provider: rule.provider,
        status: needsApproval ? 'confirmed' : 'available',
        sourceReferralId: extra.sourceReferralId,
        milestoneSalesCount: extra.milestoneSalesCount,
        pointsAmount: rule.pointsAmount,
        description: rule.description,
        costValue: rule.costValue ?? 0,
        confirmedAt: now,
        availableAt: needsApproval ? undefined : now,
      });
    } catch (err: any) {
      if (err?.code === 11000) return null; // already issued (idempotent retry) — no-op
      throw err;
    }

    campaign.rewardBudgetSpent += rule.costValue ?? 0;
    await campaign.save();

    if (reward.status === 'available') promoter.confirmedRewardsCount += 1;
    else promoter.pendingRewardsCount += 1;

    if (rule.rewardType === 'points' && rule.pointsAmount) {
      await ShareEarnPointsAward.create({
        buyerId: promoter.buyerId, rewardId: reward._id, campaignId: campaign._id, eventId: campaign.eventId, points: rule.pointsAmount,
      }).catch((e: any) => { if (e?.code !== 11000) throw e; });
    }

    await log(campaign._id as Types.ObjectId, campaign.eventId, 'reward_created', {
      promoterId: promoter._id as Types.ObjectId, rewardId: reward._id as Types.ObjectId, actorType: 'system',
      metadata: { ruleId: rule.ruleId, trigger: rule.trigger },
    });

    if (rule.trigger === 'milestone') {
      NotificationService.create('buyer', String(promoter.buyerId), 'share_earn_milestone_reached',
        'Milestone reached!', `You hit a Share&Earn milestone — your reward is ${reward.status === 'available' ? 'ready' : 'being confirmed'}.`,
        { shareEarnCampaignId: String(campaign._id), shareEarnRewardId: String(reward._id) })
        .catch((e) => console.error('[shareEarn] milestone notification failed', e));
    }

    return reward;
  }

  /** Reverses every reward tied to a disqualified/reversed referral. Points already banked get an honest offsetting ledger entry rather than a silent negative balance. */
  private static async reverseRewardsForReferral(referral: IShareEarnReferral, campaign: IShareEarnCampaign, reason: string): Promise<void> {
    const rewards = await ShareEarnReward.find({ sourceReferralId: referral._id, status: { $ne: 'reversed' } });
    const promoter = await ShareEarnPromoter.findById(referral.promoterId);
    for (const reward of rewards) {
      const wasAvailableOrRedeemed = reward.status === 'available' || reward.status === 'redeemed';
      reward.status = 'reversed';
      reward.reversedAt = new Date();
      reward.reversedReason = reason;
      await reward.save();
      await log(campaign._id as Types.ObjectId, campaign.eventId, 'reward_reversed', {
        rewardId: reward._id as Types.ObjectId, promoterId: reward.promoterId, actorType: 'system', reason,
      });
      if (promoter) {
        if (wasAvailableOrRedeemed) promoter.confirmedRewardsCount = Math.max(0, promoter.confirmedRewardsCount - 1);
        else promoter.pendingRewardsCount = Math.max(0, promoter.pendingRewardsCount - 1);
      }
      if (reward.rewardType === 'points' && reward.pointsAmount && wasAvailableOrRedeemed) {
        await ShareEarnPointsAward.create({
          buyerId: reward.buyerId, rewardId: new mongoose.Types.ObjectId(), campaignId: campaign._id, eventId: campaign.eventId, points: -reward.pointsAmount,
        }).catch((e) => console.error('[shareEarn] points reversal ledger write failed', e));
      }
      NotificationService.create('buyer', String(reward.buyerId), 'share_earn_reward_reversed',
        'A Share&Earn reward was reversed', reason, { shareEarnRewardId: String(reward._id) })
        .catch((e) => console.error('[shareEarn] reversal notification failed', e));
    }
    if (promoter) {
      promoter.confirmedSalesCount = Math.max(0, promoter.confirmedSalesCount - 1);
      promoter.ticketsSoldCount = Math.max(0, promoter.ticketsSoldCount - referral.eligibleTicketCount);
      promoter.eligibleSalesValue = Math.max(0, promoter.eligibleSalesValue - referral.eligibleSalesValue);
      await promoter.save();
    }
  }

  /**
   * A ticket from a referred sale was refunded — reverse the referral (and
   * anything it earned) unless it's already reversed/disqualified. Fires
   * on ANY refunded ticket from the sale: a per-sale/milestone reward is
   * earned by the SALE, not by individual tickets, so a partial refund still
   * withdraws the whole reward rather than leaving a partially-earned one.
   */
  static async reverseReferralForRefund(sale: ITicketSale, _ticket: ITicket): Promise<void> {
    try {
      const referral = await ShareEarnReferral.findOne({ ticketSaleId: sale._id, status: { $in: ['pending', 'confirmed'] } });
      if (!referral) return;
      const campaign = await ShareEarnCampaign.findById(referral.campaignId);
      if (!campaign) return;
      const wasConfirmed = referral.status === 'confirmed';
      referral.status = 'reversed';
      referral.reversedAt = new Date();
      referral.reversedReason = 'A ticket from this sale was refunded';
      await referral.save();
      await log(campaign._id as Types.ObjectId, campaign.eventId, 'referral_reversed', {
        referralId: referral._id as Types.ObjectId, promoterId: referral.promoterId, actorType: 'system', reason: referral.reversedReason,
      });
      if (wasConfirmed) await ShareEarnService.reverseRewardsForReferral(referral, campaign, referral.reversedReason);
    } catch (err) {
      console.error('[shareEarn] reverseReferralForRefund failed (non-fatal)', err);
    }
  }

  // ───────────────────────── Buyer: My Share&Earn ────────────────────────────

  static async getMyShareEarn(buyer: { _id: Types.ObjectId }) {
    const promoters = await ShareEarnPromoter.find({ buyerId: buyer._id }).sort({ _id: -1 })
      .populate({ path: 'eventId', select: 'name posterUrl eventDate venue' })
      .populate({ path: 'campaignId' });

    const active: any[] = [];
    const completed: any[] = [];
    for (const p of promoters as any[]) {
      const campaign: IShareEarnCampaign | undefined = p.campaignId;
      const view = {
        promoterId: String(p._id),
        campaignId: campaign ? String(campaign._id) : null,
        event: p.eventId ? { id: String(p.eventId._id), name: p.eventId.name, posterUrl: p.eventId.posterUrl ?? null, eventDate: p.eventId.eventDate, venue: p.eventId.venue } : null,
        referralCode: p.referralCode,
        status: p.status,
        clicks: p.clicks,
        confirmedSalesCount: p.confirmedSalesCount,
        ticketsSoldCount: p.ticketsSoldCount,
        pendingRewardsCount: p.pendingRewardsCount,
        confirmedRewardsCount: p.confirmedRewardsCount,
        redeemedRewardsCount: p.redeemedRewardsCount,
        nextMilestone: campaign ? nextMilestone(campaign, p) : null,
        campaignClosingDate: campaign?.endsAt ?? null,
        campaignStatus: campaign?.status ?? null,
      };
      if (campaign?.status === 'closed') completed.push(view);
      else active.push(view);
    }

    const rewards = await ShareEarnReward.find({ buyerId: buyer._id, status: { $ne: 'reversed' } }).sort({ _id: -1 })
      .populate({ path: 'eventId', select: 'name posterUrl' });
    return {
      active,
      completed,
      rewards: (rewards as any[]).map((r) => ShareEarnService.toRewardBuyerView(r)),
    };
  }

  static async redeemReward(buyer: { _id: Types.ObjectId }, rewardId: string) {
    const reward = await ShareEarnReward.findOne({ _id: rewardId, buyerId: buyer._id });
    if (!reward) throw new HttpError(404, 'Reward not found');
    if (reward.rewardType === 'points') throw new HttpError(400, 'Points are used automatically at checkout, not redeemed here');
    if (reward.status === 'redeemed') throw new HttpError(400, 'Already redeemed');
    if (reward.status !== 'available') throw new HttpError(400, 'This reward is not available yet');
    reward.status = 'redeemed';
    reward.redeemedAt = new Date();
    await reward.save();
    await ShareEarnPromoter.updateOne({ _id: reward.promoterId }, { $inc: { confirmedRewardsCount: -1, redeemedRewardsCount: 1 } });
    await log(reward.campaignId, reward.eventId, 'reward_redeemed', { rewardId: reward._id as Types.ObjectId, promoterId: reward.promoterId, actorType: 'buyer', actorId: buyer._id });
    return reward;
  }

  /** Organizer confirms a reward that needed fulfilment approval (spec §10). */
  static async confirmRewardFulfilment(eventId: string, vendorId: string, rewardId: string) {
    const campaign = await requireOwnedCampaign(eventId, vendorId);
    const reward = await ShareEarnReward.findOne({ _id: rewardId, campaignId: campaign._id });
    if (!reward) throw new HttpError(404, 'Reward not found');
    if (reward.status !== 'confirmed') throw new HttpError(400, `Reward is ${reward.status}, not awaiting confirmation`);
    reward.status = 'available';
    reward.availableAt = new Date();
    await reward.save();
    await ShareEarnPromoter.updateOne({ _id: reward.promoterId }, { $inc: { pendingRewardsCount: -1, confirmedRewardsCount: 1 } });
    await log(campaign._id as Types.ObjectId, campaign.eventId, 'reward_confirmed', { rewardId: reward._id as Types.ObjectId, promoterId: reward.promoterId, actorType: 'vendor', actorId: new Types.ObjectId(vendorId) });
    NotificationService.create('buyer', String(reward.buyerId), 'share_earn_reward_available', 'Your reward is ready', 'A Share&Earn reward is now available to redeem.', { shareEarnRewardId: String(reward._id) })
      .catch((e) => console.error('[shareEarn] reward-available notification failed', e));
    return reward;
  }

  // ───────────────────────── Leaderboard ─────────────────────────────────────

  static async getLeaderboard(eventId: string) {
    const campaign = await ShareEarnCampaign.findOne({ eventId, status: { $in: ['active', 'paused', 'closed'] } });
    if (!campaign || !campaign.showLeaderboard) return null;
    const rows = await ShareEarnPromoter.find({ campaignId: campaign._id, optOutLeaderboard: false, confirmedSalesCount: { $gt: 0 } })
      .sort({ confirmedSalesCount: -1 }).limit(50)
      .populate('buyerId', 'name username avatarUrl');
    return rows.map((p: any, idx) => ({
      rank: idx + 1,
      buyer: p.buyerId ? { name: p.buyerId.name, username: p.buyerId.username, avatarUrl: p.buyerId.avatarUrl } : null,
      confirmedSalesCount: p.confirmedSalesCount,
      nextMilestone: nextMilestone(campaign, p),
    }));
  }

  // ───────────────────────── View mappers ────────────────────────────────────

  static toPublicCampaignView(c: IShareEarnCampaign) {
    return {
      id: String(c._id),
      eventId: String(c.eventId),
      status: c.status,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      eligibleTicketTypeIds: c.eligibleTicketTypeIds,
      rewardRules: c.rewardRules,
      allowSelfReferral: c.allowSelfReferral,
      showLeaderboard: c.showLeaderboard,
      requirePromoterApproval: c.requirePromoterApproval,
      terms: c.terms ?? null,
    };
  }

  static toOrganizerCampaignView(c: IShareEarnCampaign) {
    return {
      id: String(c._id),
      eventId: String(c.eventId),
      status: c.status,
      startsAt: c.startsAt,
      endsAt: c.endsAt,
      eligibleTicketTypeIds: c.eligibleTicketTypeIds,
      rewardRules: c.rewardRules,
      maxPromoters: c.maxPromoters ?? null,
      maxRewardBudget: c.maxRewardBudget ?? null,
      rewardBudgetSpent: c.rewardBudgetSpent,
      allowSelfReferral: c.allowSelfReferral,
      showLeaderboard: c.showLeaderboard,
      requirePromoterApproval: c.requirePromoterApproval,
      registrationsPaused: c.registrationsPaused,
      terms: c.terms ?? null,
      activatedAt: c.activatedAt ?? null,
      pausedAt: c.pausedAt ?? null,
      closedAt: c.closedAt ?? null,
    };
  }

  static toPromoterBuyerView(p: IShareEarnPromoter, c: IShareEarnCampaign) {
    return {
      promoterId: String(p._id),
      referralCode: p.referralCode,
      status: p.status,
      clicks: p.clicks,
      confirmedSalesCount: p.confirmedSalesCount,
      nextMilestone: nextMilestone(c, p),
    };
  }

  static toPromoterAdminView(p: any) {
    return {
      promoterId: String(p._id),
      buyer: p.buyerId ? { id: String(p.buyerId._id), name: p.buyerId.name, username: p.buyerId.username, avatarUrl: p.buyerId.avatarUrl, phone: p.buyerId.phone, email: p.buyerId.email } : null,
      referralCode: p.referralCode,
      status: p.status,
      clicks: p.clicks,
      uniqueVisitors: p.uniqueVisitors,
      checkoutAttempts: p.checkoutAttempts,
      confirmedSalesCount: p.confirmedSalesCount,
      ticketsSoldCount: p.ticketsSoldCount,
      eligibleSalesValue: p.eligibleSalesValue,
      pendingRewardsCount: p.pendingRewardsCount,
      confirmedRewardsCount: p.confirmedRewardsCount,
      redeemedRewardsCount: p.redeemedRewardsCount,
      joinedAt: p.joinedAt,
    };
  }

  static toRewardBuyerView(r: any) {
    return {
      id: String(r._id),
      event: r.eventId ? { id: String(r.eventId._id), name: r.eventId.name, posterUrl: r.eventId.posterUrl ?? null } : null,
      rewardType: r.rewardType,
      provider: r.provider,
      trigger: r.trigger,
      status: r.status,
      pointsAmount: r.pointsAmount ?? null,
      description: r.description ?? null,
      confirmedAt: r.confirmedAt ?? null,
      availableAt: r.availableAt ?? null,
      redeemedAt: r.redeemedAt ?? null,
    };
  }
}
