import { Schema, model, Document, Types } from 'mongoose';
import { ShareEarnPromoterStatus } from '@interfaces/shareEarn.interface';

/**
 * One row per (campaign, buyer) — a buyer's registration as a promoter for
 * one event's Share&Earn campaign. `referralCode` is the short, unique,
 * unguessable token every share link/QR encodes; resolved back to this row
 * on click and at checkout attribution.
 *
 * Counters are denormalised here (rather than always aggregated from
 * ShareEarnClick/Referral/Reward) so "My Share&Earn" and the organizer
 * promoter table are cheap single-document reads; they are updated
 * transactionally alongside the rows that back them — see ShareEarnService.
 */
export interface IShareEarnPromoter extends Document {
  campaignId: Types.ObjectId;
  eventId: Types.ObjectId;
  buyerId: Types.ObjectId;
  referralCode: string;
  status: ShareEarnPromoterStatus;
  optOutLeaderboard: boolean;

  clicks: number;
  uniqueVisitors: number;
  checkoutAttempts: number;
  confirmedSalesCount: number;
  ticketsSoldCount: number;
  eligibleSalesValue: number;
  pendingRewardsCount: number;
  confirmedRewardsCount: number;
  redeemedRewardsCount: number;

  /** ruleIds of milestone/top_promoter rules already awarded — guards double-award. */
  awardedMilestoneRuleIds: string[];

  joinedAt: Date;
  approvedAt?: Date;
  disqualifiedAt?: Date;
  disqualifiedReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const shareEarnPromoterSchema = new Schema<IShareEarnPromoter>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'ShareEarnCampaign', required: true, index: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    referralCode: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ['pending_approval', 'active', 'paused', 'disqualified'], required: true, default: 'active' },
    optOutLeaderboard: { type: Boolean, default: false },

    clicks: { type: Number, default: 0, min: 0 },
    uniqueVisitors: { type: Number, default: 0, min: 0 },
    checkoutAttempts: { type: Number, default: 0, min: 0 },
    confirmedSalesCount: { type: Number, default: 0, min: 0 },
    ticketsSoldCount: { type: Number, default: 0, min: 0 },
    eligibleSalesValue: { type: Number, default: 0, min: 0 },
    pendingRewardsCount: { type: Number, default: 0, min: 0 },
    confirmedRewardsCount: { type: Number, default: 0, min: 0 },
    redeemedRewardsCount: { type: Number, default: 0, min: 0 },

    awardedMilestoneRuleIds: { type: [String], default: [] },

    joinedAt: { type: Date, required: true, default: Date.now },
    approvedAt: { type: Date },
    disqualifiedAt: { type: Date },
    disqualifiedReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// Prevent duplicate promoter registrations for the same buyer/event (spec §3).
shareEarnPromoterSchema.index({ campaignId: 1, buyerId: 1 }, { unique: true });
// "My Share&Earn" active/completed lists — a buyer's rows, newest first.
shareEarnPromoterSchema.index({ buyerId: 1, _id: -1 });
// Organizer promoter table + leaderboard, ranked by sales.
shareEarnPromoterSchema.index({ campaignId: 1, confirmedSalesCount: -1 });

export const ShareEarnPromoter = model<IShareEarnPromoter>('ShareEarnPromoter', shareEarnPromoterSchema);
