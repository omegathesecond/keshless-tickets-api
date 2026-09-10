import mongoose, { Schema, Document, Types } from 'mongoose';
import type { SocialActorType } from '@utils/socialActor.util';

/**
 * One buyer's (or organizer's) answer to one VoteQuestion. `optionKey` holds
 * either a fixed VoteQuestion.options[].key (artist/outfit/attending_with/
 * busy questions) or a SongSuggestion _id as a string (song questions) —
 * the question's `kind` tells the reader which.
 *
 * "Each user receives one vote per question... store only the user's latest
 * selection" (spec §5) is enforced by the unique index below PLUS every
 * write going through an upsert (`findOneAndUpdate({...}, {...}, {upsert:
 * true})` in vote.service) — a repeated tap/refresh/slow-connection retry
 * just re-sets the same row instead of creating a duplicate, and switching
 * an answer overwrites `optionKey` in place rather than adding a second row.
 *
 * Results are NEVER a maintained counter on the question/option — they are
 * always a live aggregate COUNT of this collection (see
 * vote.service#getResults), so "genuine vote totals" can't drift from a
 * $inc race the way a denormalized counter could.
 */
export interface IVoteResponse extends Document {
  questionId: Types.ObjectId;
  eventId: Types.ObjectId;
  actorType: SocialActorType;
  actorId: Types.ObjectId;
  optionKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IVoteResponse>(
  {
    questionId: { type: Schema.Types.ObjectId, ref: 'VoteQuestion', required: true, index: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
    actorId: { type: Schema.Types.ObjectId, required: true },
    optionKey: { type: String, required: true, trim: true, maxlength: 120 },
  },
  { timestamps: true },
);

// One response per (question, actor) — the whole "one vote per question,
// latest selection wins" contract lives on this index.
schema.index({ questionId: 1, actorType: 1, actorId: 1 }, { unique: true });
// Live tally: "count of responses per option for this question".
schema.index({ questionId: 1, optionKey: 1 });

export const VoteResponse = mongoose.model<IVoteResponse>('VoteResponse', schema);
