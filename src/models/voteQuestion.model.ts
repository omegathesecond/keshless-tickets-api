import mongoose, { Schema, Document, Types } from 'mongoose';

export type VoteQuestionKind = 'artist' | 'song' | 'outfit' | 'attending_with' | 'busy';

export interface IVoteOption {
  key: string;
  label: string;
}

/**
 * One Vote question for one event (spec "Vote" feature). A question is
 * materialized AT MOST ONCE per (eventId, kind) — see
 * @services/vote.service#ensureVoteQuestions — by snapshotting whatever
 * event data it's gated on (event.lineup for 'artist', event.outfitThemeOptions
 * for 'outfit') at the moment the Vote first opens. `options` is then frozen:
 * nothing in this codebase ever mutates it afterward, which is what satisfies
 * "once voting has started, do not change the questions or available
 * options" without needing a separate lock flag.
 *
 * 'song' questions carry NO options here — suggestions are user-submitted
 * (see @models/songSuggestion.model) and are the vote targets instead.
 */
export interface IVoteQuestion extends Document {
  eventId: Types.ObjectId;
  kind: VoteQuestionKind;
  prompt: string;
  order: number;
  options: IVoteOption[];
  createdAt: Date;
  updatedAt: Date;
}

const voteOptionSchema = new Schema<IVoteOption>(
  {
    key: { type: String, required: true, trim: true, maxlength: 120 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
  },
  { _id: false },
);

const schema = new Schema<IVoteQuestion>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    kind: { type: String, enum: ['artist', 'song', 'outfit', 'attending_with', 'busy'], required: true },
    prompt: { type: String, required: true, trim: true, maxlength: 200 },
    order: { type: Number, required: true, default: 0 },
    options: { type: [voteOptionSchema], default: [] },
  },
  { timestamps: true },
);

// One question of each kind per event — enforced at the DB, not just by
// ensureVoteQuestions's find-before-create, so a concurrent materialization
// race can't double-create (the loser's insert 11000s and re-reads).
schema.index({ eventId: 1, kind: 1 }, { unique: true });
// Serves "this event's questions, in display order".
schema.index({ eventId: 1, order: 1 });

export const VoteQuestion = mongoose.model<IVoteQuestion>('VoteQuestion', schema);
