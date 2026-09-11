import mongoose, { Schema, Document, Types } from 'mongoose';
import type { IfIGoAudience, IfIGoOptionDef } from '@interfaces/ifIGo.interface';

/**
 * The durable "If I Go…" poll record for one Story (spec: If I Go…). Kept as
 * its OWN collection — deliberately NOT embedded on the Story document —
 * because Story is ephemeral by design (TTL auto-delete at expiresAt, see
 * @models/story.model) while spec §14 requires the poll's AGGREGATE RESULTS
 * to survive that deletion ("keep archived results visible only to the
 * Story creator" after expiry). Embedding this in Story would mean the whole
 * poll vanishes the instant Mongo's TTL monitor reaps the parent doc.
 *
 * `expiresAt` is copied from the parent Story at creation time (not looked
 * up live) so results/response endpoints can enforce the "stop accepting
 * responses, freeze results" rule (spec §14) even after the Story doc itself
 * is gone — this document is the source of truth for that boundary from
 * then on, not Story.expiresAt.
 *
 * Options are frozen once set at creation (mirrors VoteQuestion.options —
 * see @models/voteQuestion.model) — spec §2 never allows editing options
 * after publish, only reordering/selecting BEFORE it.
 */
export interface IIfIGoStory extends Document {
  storyId: Types.ObjectId;
  eventId: Types.ObjectId;
  // Buyer-only (spec: If I Go… never mentions organizer/brand authorship —
  // unlike plain Story, which is actor-agnostic — see @models/story.model).
  creatorId: Types.ObjectId;
  question: string;
  options: IfIGoOptionDef[];
  allowMultiple: boolean;
  audience: IfIGoAudience;
  /** Creator toggle — spec §12 "disable further responses" without deleting
   *  the Story itself. */
  responsesEnabled: boolean;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const optionSchema = new Schema<IfIGoOptionDef>(
  {
    key: { type: String, required: true, trim: true, maxlength: 120 },
    label: { type: String, required: true, trim: true, maxlength: 60 },
    order: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const ifIGoStorySchema = new Schema<IIfIGoStory>(
  {
    storyId: { type: Schema.Types.ObjectId, ref: 'Story', required: true, unique: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    question: { type: String, required: true, trim: true, maxlength: 200 },
    options: { type: [optionSchema], required: true, validate: [(v: IfIGoOptionDef[]) => v.length >= 2 && v.length <= 8, 'Between 2 and 8 response options are required'] },
    allowMultiple: { type: Boolean, required: true, default: true },
    audience: { type: String, enum: ['everyone', 'followers'], required: true, default: 'everyone' },
    responsesEnabled: { type: Boolean, required: true, default: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

// A creator's own polls, newest first (for "My Account" / profile listing).
ifIGoStorySchema.index({ creatorId: 1, createdAt: -1 });
// Event-scoped listing (e.g. "polls about this event").
ifIGoStorySchema.index({ eventId: 1, createdAt: -1 });

export const IfIGoStory = mongoose.model<IIfIGoStory>('IfIGoStory', ifIGoStorySchema);
