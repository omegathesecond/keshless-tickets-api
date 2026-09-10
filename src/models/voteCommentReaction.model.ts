import mongoose, { Schema, Document, Types } from 'mongoose';

export type VoteReactionActorType = 'buyer' | 'vendor';

/**
 * "React to comments" (spec §7) — mirrors UpdateReaction/EventQuestionReaction,
 * INCLUDING their `buyerId` field name for the actor id (holds a Vendor _id
 * when actorType='vendor') — @services/reactions.service#toggleReactionGeneric
 * is written against that exact field name, and reusing it here (rather than
 * forking a fourth near-identical toggle) is the point.
 */
export interface IVoteCommentReaction extends Document {
  commentId: Types.ObjectId;
  actorType: VoteReactionActorType;
  buyerId: Types.ObjectId;
  type: 'like';
  createdAt: Date;
}

const schema = new Schema<IVoteCommentReaction>(
  {
    commentId: { type: Schema.Types.ObjectId, ref: 'VoteComment', required: true, index: true },
    actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
    buyerId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: ['like'], required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

schema.index({ commentId: 1, actorType: 1, buyerId: 1, type: 1 }, { unique: true });

export const VoteCommentReaction = mongoose.model<IVoteCommentReaction>('VoteCommentReaction', schema);
