import { Schema, model, Document, Types } from 'mongoose';
import { IShareEarnRewardRule, ShareEarnCampaignStatus } from '@interfaces/shareEarn.interface';

/**
 * One Share&Earn campaign per event (organizer-configured, draft until they
 * confirm the reward structure and activate it). Reward rules are a
 * point-in-time snapshot the organizer previewed and confirmed — see
 * ShareEarnService.updateCampaign: once ANY promoter has a confirmed sale, an
 * update may only ADD rules or loosen limits, never remove/shrink an existing
 * rule a promoter already qualified under (spec §1's "do not reduce rewards").
 */
export interface IShareEarnCampaign extends Document {
  eventId: Types.ObjectId;
  vendorId: Types.ObjectId;
  status: ShareEarnCampaignStatus;

  startsAt: Date;
  endsAt: Date;

  /** Ticket type ids (ITicketType._id) eligible for referral credit. Empty = all types. */
  eligibleTicketTypeIds: string[];

  rewardRules: IShareEarnRewardRule[];

  maxPromoters?: number;
  maxRewardBudget?: number;
  /** Running total of `costValue` across confirmed+ rewards (see rewardRules). */
  rewardBudgetSpent: number;

  allowSelfReferral: boolean;
  showLeaderboard: boolean;
  requirePromoterApproval: boolean;
  /** Organizer can freeze new signups without pausing tracking/payout for existing promoters. */
  registrationsPaused: boolean;

  terms?: string;

  activatedAt?: Date;
  pausedAt?: Date;
  closedAt?: Date;

  createdBy: Types.ObjectId; // Vendor
  updatedBy?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const rewardRuleSchema = new Schema<IShareEarnRewardRule>(
  {
    ruleId: { type: String, required: true },
    trigger: { type: String, enum: ['per_sale', 'milestone', 'top_promoter'], required: true },
    milestoneSalesCount: { type: Number, min: 1 },
    rewardType: {
      type: String,
      enum: ['points', 'ticket_discount', 'free_ticket', 'upgrade', 'voucher', 'merchandise', 'benefit'],
      required: true,
    },
    provider: { type: String, enum: ['carrot', 'organizer'], required: true, default: 'organizer' },
    pointsAmount: { type: Number, min: 0 },
    description: { type: String, trim: true, maxlength: 300 },
    costValue: { type: Number, min: 0 },
  },
  { _id: false }
);

const shareEarnCampaignSchema = new Schema<IShareEarnCampaign>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, unique: true, index: true },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    status: { type: String, enum: ['draft', 'active', 'paused', 'closed'], required: true, default: 'draft', index: true },

    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },

    eligibleTicketTypeIds: { type: [String], default: [] },

    rewardRules: { type: [rewardRuleSchema], default: [] },

    maxPromoters: { type: Number, min: 1 },
    maxRewardBudget: { type: Number, min: 0 },
    rewardBudgetSpent: { type: Number, default: 0, min: 0 },

    allowSelfReferral: { type: Boolean, default: false },
    showLeaderboard: { type: Boolean, default: true },
    requirePromoterApproval: { type: Boolean, default: false },
    registrationsPaused: { type: Boolean, default: false },

    terms: { type: String, trim: true, maxlength: 4000 },

    activatedAt: { type: Date },
    pausedAt: { type: Date },
    closedAt: { type: Date },

    createdBy: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Vendor' },
  },
  { timestamps: true }
);

// Home feed / discovery: active campaigns closing soon.
shareEarnCampaignSchema.index({ status: 1, endsAt: 1 });

export const ShareEarnCampaign = model<IShareEarnCampaign>('ShareEarnCampaign', shareEarnCampaignSchema);
