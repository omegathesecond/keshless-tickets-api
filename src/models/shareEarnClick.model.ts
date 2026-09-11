import { Schema, model, Document, Types } from 'mongoose';

/**
 * One row per referral-link open. `visitorKey` is a client-generated id
 * (persisted in the visitor's localStorage by the frontend) used only to
 * de-duplicate "unique visitors" per promoter — never treated as identity.
 * Anonymous by design: a logged-out visitor may browse the event before
 * signing in to buy (spec §4).
 */
export interface IShareEarnClick extends Document {
  campaignId: Types.ObjectId;
  promoterId: Types.ObjectId;
  visitorKey: string;
  ip?: string;
  userAgent?: string;
  createdAt: Date;
}

const shareEarnClickSchema = new Schema<IShareEarnClick>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'ShareEarnCampaign', required: true, index: true },
    promoterId: { type: Schema.Types.ObjectId, ref: 'ShareEarnPromoter', required: true, index: true },
    visitorKey: { type: String, required: true, trim: true, maxlength: 100 },
    ip: { type: String, trim: true },
    userAgent: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

shareEarnClickSchema.index({ promoterId: 1, visitorKey: 1 });
shareEarnClickSchema.index({ promoterId: 1, createdAt: -1 });

export const ShareEarnClick = model<IShareEarnClick>('ShareEarnClick', shareEarnClickSchema);
