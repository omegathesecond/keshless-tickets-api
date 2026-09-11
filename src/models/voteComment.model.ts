import mongoose, { Schema, Document, Types } from 'mongoose';
import type { SocialActorType } from '@utils/socialActor.util';

/**
 * A discussion comment or reply on one Vote question (spec §7 — every Vote
 * has a discussion area). `parentId` set = a reply to another comment
 * (one level of nesting, matching the spec's "post comments / reply to
 * comments" — it does not ask for reply-to-reply threading). Both a comment
 * and every reply carry their OWN eventId + questionId (denormalized, like
 * EventQuestionReply) so "every comment and reply must remain connected to
 * the correct event and Vote question" holds without a join back through the
 * parent.
 *
 * Soft-deleted (status:'removed'), matching UpdateComment — a moderated or
 * self-deleted comment must never resurface in a list read, but its replies
 * (if any) keep their own independent status.
 */
export interface IVoteComment extends Document {
  eventId: Types.ObjectId;
  questionId: Types.ObjectId;
  parentId?: Types.ObjectId;
  authorType: SocialActorType;
  authorId: Types.ObjectId;
  body: string;
  status: 'active' | 'removed';
  removedBy?: string;
  replyCount: number;
  likeCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IVoteComment>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    questionId: { type: Schema.Types.ObjectId, ref: 'VoteQuestion', required: true, index: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'VoteComment' },
    authorType: { type: String, enum: ['buyer', 'vendor'], required: true },
    authorId: { type: Schema.Types.ObjectId, required: true },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    status: { type: String, enum: ['active', 'removed'], default: 'active' },
    // The moderator (vendor/sub-user id, or 'platform' for a superadmin) who
    // removed this — audit trail, mirrors Update's hiddenFromDiscoverBy.
    removedBy: { type: String },
    replyCount: { type: Number, default: 0 },
    likeCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Top-level comments for a question, newest first.
schema.index({ questionId: 1, parentId: 1, status: 1, createdAt: -1 });
// Replies for one parent comment, oldest first (thread read order).
schema.index({ parentId: 1, status: 1, createdAt: 1 });

export const VoteComment = mongoose.model<IVoteComment>('VoteComment', schema);
