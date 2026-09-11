import mongoose, { Schema, Document, Types } from 'mongoose';

export type AttendeeTagStatus = 'pending' | 'confirmed' | 'declined';

/**
 * A "who are you attending with" tag: buyer A (taggedById) names buyer B
 * (taggedUserId) as someone they're going with, on one event's
 * 'attending_with' VoteQuestion. Buyer-to-buyer only (an organizer brand
 * doesn't "attend with" anyone), unlike VoteResponse/VoteComment which are
 * actor-polymorphic.
 *
 * "Only confirmed tags should become publicly visible in the Vote" (spec
 * §2) — every read site filters `status: 'confirmed'`; pending/declined rows
 * are visible only to the two parties involved (vote.service).
 */
export interface IAttendeeTag extends Document {
  eventId: Types.ObjectId;
  questionId: Types.ObjectId;
  taggedById: Types.ObjectId;
  taggedUserId: Types.ObjectId;
  status: AttendeeTagStatus;
  respondedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IAttendeeTag>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    questionId: { type: Schema.Types.ObjectId, ref: 'VoteQuestion', required: true, index: true },
    taggedById: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    taggedUserId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    status: { type: String, enum: ['pending', 'confirmed', 'declined'], required: true, default: 'pending' },
    respondedAt: { type: Date },
  },
  { timestamps: true },
);

// "Prevent duplicate tag requests" (spec §2) — one tag per (tagger, target)
// per question. A declined tag is NOT re-opened by re-requesting (unlike
// MeetupRequest) — the tagger removes it first (DELETE) and creates a fresh
// one, keeping the confirm/decline history explicit rather than silently
// flipping a stale row back to pending.
schema.index({ questionId: 1, taggedById: 1, taggedUserId: 1 }, { unique: true });
// "Tags naming me" — for the notification/confirm-decline surface.
schema.index({ taggedUserId: 1, status: 1 });
// "Confirmed tags on my own answer" — the public-visible read.
schema.index({ questionId: 1, taggedById: 1, status: 1 });

export const AttendeeTag = mongoose.model<IAttendeeTag>('AttendeeTag', schema);
