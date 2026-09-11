import { Schema, model, Document, Types } from 'mongoose';
import { ShareEarnAuditAction } from '@interfaces/shareEarn.interface';

/**
 * Append-only audit trail (spec §16): referral attribution, ticket
 * confirmation, reward creation/confirmation/reversal/redemption, and every
 * organizer disqualification — each with who/what/why so a disqualified sale
 * or reward can be appealed and reviewed.
 */
export interface IShareEarnAuditLog extends Document {
  campaignId: Types.ObjectId;
  eventId: Types.ObjectId;
  action: ShareEarnAuditAction;
  promoterId?: Types.ObjectId;
  referralId?: Types.ObjectId;
  rewardId?: Types.ObjectId;
  actorType: 'buyer' | 'vendor' | 'system';
  actorId?: Types.ObjectId;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const shareEarnAuditLogSchema = new Schema<IShareEarnAuditLog>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'ShareEarnCampaign', required: true, index: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    action: { type: String, required: true, index: true },
    promoterId: { type: Schema.Types.ObjectId, ref: 'ShareEarnPromoter', index: true },
    referralId: { type: Schema.Types.ObjectId, ref: 'ShareEarnReferral' },
    rewardId: { type: Schema.Types.ObjectId, ref: 'ShareEarnReward' },
    actorType: { type: String, enum: ['buyer', 'vendor', 'system'], required: true },
    actorId: { type: Schema.Types.ObjectId },
    reason: { type: String, trim: true, maxlength: 1000 },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

shareEarnAuditLogSchema.index({ campaignId: 1, createdAt: -1 });

export const ShareEarnAuditLog = model<IShareEarnAuditLog>('ShareEarnAuditLog', shareEarnAuditLogSchema);
