import mongoose, { Schema, Document, Types } from 'mongoose';
import type { IfIGoResponseStatus } from '@interfaces/ifIGo.interface';

/** One selected option within a respondent's answer, with its own private
 *  status lifecycle (spec §7) — a respondent picking BOTH "Buy me a ticket"
 *  and "Go with me" tracks two independent statuses, not one shared one. */
export interface IIfIGoSelection {
  optionKey: string;
  status: IfIGoResponseStatus;
  statusChangedAt: Date;
}

/**
 * One buyer's (or organizer's) response to one IfIGoStory poll. Exactly one
 * row per (ifIGoStoryId, respondentId) — the whole "change or remove your
 * response while active" contract (spec §5) lives on the unique index below
 * PLUS every write going through an upsert (mirrors
 * @models/voteResponse.model's documented pattern exactly), so a repeated
 * tap/retry never creates a duplicate and switching selections overwrites
 * `selections` in place rather than adding a second row.
 *
 * Public results are NEVER read off a maintained counter — always a live
 * aggregate over this collection (see ifIGo.service#getResults), same
 * anti-drift reasoning as VoteResponse.
 */
export interface IIfIGoResponse extends Document {
  ifIGoStoryId: Types.ObjectId;
  storyId: Types.ObjectId;
  eventId: Types.ObjectId;
  // Buyer-only, same scope decision as IfIGoStory.creatorId.
  respondentId: Types.ObjectId;
  selections: IIfIGoSelection[];
  /** Optional private note to the creator (spec §5) — never surfaced publicly. */
  privateMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

const selectionSchema = new Schema<IIfIGoSelection>(
  {
    optionKey: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: ['interested', 'offered', 'request_sent', 'accepted', 'declined', 'completed'], required: true, default: 'interested' },
    statusChangedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const ifIGoResponseSchema = new Schema<IIfIGoResponse>(
  {
    ifIGoStoryId: { type: Schema.Types.ObjectId, ref: 'IfIGoStory', required: true, index: true },
    storyId: { type: Schema.Types.ObjectId, ref: 'Story', required: true, index: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    respondentId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    selections: { type: [selectionSchema], required: true, default: [] },
    privateMessage: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true },
);

// One response per (poll, respondent) — the whole upsert/dedup contract.
ifIGoResponseSchema.index({ ifIGoStoryId: 1, respondentId: 1 }, { unique: true });
// Live tally: "responses for this poll, unwound by selected option".
ifIGoResponseSchema.index({ ifIGoStoryId: 1, 'selections.optionKey': 1 });

export const IfIGoResponse = mongoose.model<IIfIGoResponse>('IfIGoResponse', ifIGoResponseSchema);
