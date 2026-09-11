import { Schema, model, Document, Types } from 'mongoose';
import { ShareEarnRewardProvider, ShareEarnRewardStatus, ShareEarnRewardTriggerKind, ShareEarnRewardType } from '@interfaces/shareEarn.interface';

/**
 * One issued reward instance for a promoter — a per-sale points award, a
 * milestone reward, or the top-promoter reward. `sourceReferralId` links a
 * per_sale reward back to the qualifying sale (absent for milestone/
 * top_promoter, which aggregate many sales); reversing that referral
 * reverses this reward (see ShareEarnService.reverseReferral).
 */
export interface IShareEarnReward extends Document {
  campaignId: Types.ObjectId;
  eventId: Types.ObjectId;
  promoterId: Types.ObjectId;
  buyerId: Types.ObjectId;

  ruleId: string;
  trigger: ShareEarnRewardTriggerKind;
  rewardType: ShareEarnRewardType;
  provider: ShareEarnRewardProvider;
  status: ShareEarnRewardStatus;

  sourceReferralId?: Types.ObjectId;
  milestoneSalesCount?: number;

  pointsAmount?: number;
  description?: string;
  costValue: number;

  confirmedAt?: Date;
  availableAt?: Date;
  redeemedAt?: Date;
  reversedAt?: Date;
  reversedReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const shareEarnRewardSchema = new Schema<IShareEarnReward>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'ShareEarnCampaign', required: true, index: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    promoterId: { type: Schema.Types.ObjectId, ref: 'ShareEarnPromoter', required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },

    ruleId: { type: String, required: true },
    trigger: { type: String, enum: ['per_sale', 'milestone', 'top_promoter'], required: true },
    rewardType: {
      type: String,
      enum: ['points', 'ticket_discount', 'free_ticket', 'upgrade', 'voucher', 'merchandise', 'benefit'],
      required: true,
    },
    provider: { type: String, enum: ['carrot', 'organizer'], required: true },
    status: { type: String, enum: ['pending', 'confirmed', 'available', 'redeemed', 'reversed'], required: true, default: 'pending', index: true },

    sourceReferralId: { type: Schema.Types.ObjectId, ref: 'ShareEarnReferral' },
    milestoneSalesCount: { type: Number },

    pointsAmount: { type: Number, min: 0 },
    description: { type: String, trim: true, maxlength: 300 },
    costValue: { type: Number, default: 0, min: 0 },

    confirmedAt: { type: Date },
    availableAt: { type: Date },
    redeemedAt: { type: Date },
    reversedAt: { type: Date },
    reversedReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// One per_sale reward per referral — guards duplicate issue on a retried confirm.
shareEarnRewardSchema.index(
  { sourceReferralId: 1, ruleId: 1 },
  { unique: true, partialFilterExpression: { sourceReferralId: { $type: 'objectId' } } }
);
// A milestone/top_promoter reward fires once per (promoter, rule) — see also
// ShareEarnPromoter.awardedMilestoneRuleIds, which guards the race; this index
// backstops it at the data layer.
shareEarnRewardSchema.index({ promoterId: 1, ruleId: 1, trigger: 1 }, { unique: true, partialFilterExpression: { trigger: { $in: ['milestone', 'top_promoter'] } } });
shareEarnRewardSchema.index({ buyerId: 1, status: 1, _id: -1 });
shareEarnRewardSchema.index({ campaignId: 1, status: 1 });

export const ShareEarnReward = model<IShareEarnReward>('ShareEarnReward', shareEarnRewardSchema);
