import { Schema, model, Document, Types } from 'mongoose';
import { ShareEarnReferralStatus } from '@interfaces/shareEarn.interface';

/**
 * One row per attributed ticket sale — the unit "success" is measured in
 * (spec §5/§6). Created 'pending' when a buyer checks out carrying a
 * referral code (before payment confirms), flipped to 'confirmed' when
 * TicketService actually mints the tickets, 'reversed' on refund/cancel, or
 * 'disqualified' by an organizer/fraud review with a recorded reason.
 *
 * Unique on ticketSaleId: a sale is claimed by at most one promoter (spec
 * §5's "do not award the same ticket sale to more than one promoter") — the
 * unique index is the enforcement, not just app logic.
 */
export interface IShareEarnReferral extends Document {
  campaignId: Types.ObjectId;
  eventId: Types.ObjectId;
  promoterId: Types.ObjectId;
  buyerId?: Types.ObjectId; // the referred purchaser, when known (logged-in checkout)
  ticketSaleId: Types.ObjectId;
  status: ShareEarnReferralStatus;

  eligibleTicketCount: number;
  eligibleSalesValue: number;

  confirmedAt?: Date;
  reversedAt?: Date;
  reversedReason?: string;
  disqualifiedAt?: Date;
  disqualifiedReason?: string;
  disqualifiedBy?: Types.ObjectId; // Vendor, when organizer-initiated

  flagged: boolean;
  flaggedReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const shareEarnReferralSchema = new Schema<IShareEarnReferral>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'ShareEarnCampaign', required: true, index: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    promoterId: { type: Schema.Types.ObjectId, ref: 'ShareEarnPromoter', required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', index: true, sparse: true },
    ticketSaleId: { type: Schema.Types.ObjectId, ref: 'TicketSale', required: true, unique: true },
    status: { type: String, enum: ['pending', 'confirmed', 'reversed', 'disqualified'], required: true, default: 'pending', index: true },

    eligibleTicketCount: { type: Number, default: 0, min: 0 },
    eligibleSalesValue: { type: Number, default: 0, min: 0 },

    confirmedAt: { type: Date },
    reversedAt: { type: Date },
    reversedReason: { type: String, trim: true, maxlength: 500 },
    disqualifiedAt: { type: Date },
    disqualifiedReason: { type: String, trim: true, maxlength: 500 },
    disqualifiedBy: { type: Schema.Types.ObjectId, ref: 'Vendor' },

    flagged: { type: Boolean, default: false, index: true },
    flaggedReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

shareEarnReferralSchema.index({ promoterId: 1, status: 1, _id: -1 });
shareEarnReferralSchema.index({ campaignId: 1, flagged: 1 });

export const ShareEarnReferral = model<IShareEarnReferral>('ShareEarnReferral', shareEarnReferralSchema);
