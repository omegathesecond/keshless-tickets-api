import mongoose, { Schema, Document, Types } from 'mongoose';
import type { SocialActorType } from '@utils/socialActor.util';

/**
 * A user-submitted song for a 'song' VoteQuestion ("What song must the DJ
 * play?"). Voting FOR a suggestion is a normal VoteResponse whose optionKey
 * is this document's _id — see vote.service#castVote.
 *
 * Dedup ("prevent duplicate song suggestions where possible" — spec §2):
 * `normalizedKey` is `title|artist` lowercased/trimmed/whitespace-collapsed,
 * unique per question. suggestSong() looks this up BEFORE creating so a
 * near-duplicate resolves to the existing row (and the suggester is voted
 * onto it) instead of erroring or forking the tally — "where possible"
 * because a materially different spelling still creates a new entry.
 */
export interface ISongSuggestion extends Document {
  eventId: Types.ObjectId;
  questionId: Types.ObjectId;
  suggestedByType: SocialActorType;
  suggestedById: Types.ObjectId;
  title: string;
  artist?: string;
  normalizedKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ISongSuggestion>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    questionId: { type: Schema.Types.ObjectId, ref: 'VoteQuestion', required: true, index: true },
    suggestedByType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
    suggestedById: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    artist: { type: String, trim: true, maxlength: 150 },
    normalizedKey: { type: String, required: true },
  },
  { timestamps: true },
);

schema.index({ questionId: 1, normalizedKey: 1 }, { unique: true });
// "Song suggestions for this question, newest first" (organizer dashboard +
// the public options list).
schema.index({ questionId: 1, createdAt: -1 });

export const SongSuggestion = mongoose.model<ISongSuggestion>('SongSuggestion', schema);
