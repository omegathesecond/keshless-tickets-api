import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Persisted points ledger for Share&Earn 'points' rewards — mirrors
 * StoryPointsAward's pattern (a ledger, not a live-recomputed count) because
 * a Share&Earn point award is an EVENT (a confirmed referred sale, or a
 * milestone reached) with no other durable record once issued. Summed by
 * totalShareEarnPoints and folded into the buyer's points balance alongside
 * post/ticket/story points — see SocialProfileController.me and the
 * website's src/lib/points.ts.
 *
 * `points` may be NEGATIVE: ShareEarnService.reverseRewardsForReferral writes
 * an offsetting entry (rather than mutating/deleting the original award) when
 * an already-banked points reward is reversed, so the ledger stays an honest,
 * append-only record of every award AND every reversal.
 */
export interface IShareEarnPointsAward extends Document {
  buyerId: Types.ObjectId;
  rewardId: Types.ObjectId; // ShareEarnReward this award backs — one-to-one
  campaignId: Types.ObjectId;
  eventId: Types.ObjectId;
  points: number;
  createdAt: Date;
}

const shareEarnPointsAwardSchema = new Schema<IShareEarnPointsAward>(
  {
    buyerId: { type: Schema.Types.ObjectId, required: true, index: true },
    // Unique: one award per reward, so a retried confirm can't double-credit.
    rewardId: { type: Schema.Types.ObjectId, required: true, unique: true },
    campaignId: { type: Schema.Types.ObjectId, required: true },
    eventId: { type: Schema.Types.ObjectId, required: true },
    // No min(0): a reversal entry is a legitimate negative award — see above.
    points: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

shareEarnPointsAwardSchema.index({ buyerId: 1, createdAt: -1 });

export const ShareEarnPointsAward = mongoose.model<IShareEarnPointsAward>('ShareEarnPointsAward', shareEarnPointsAwardSchema);
