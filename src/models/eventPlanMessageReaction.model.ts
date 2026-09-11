import { Schema, model, Document, Types } from 'mongoose';

/** Fixed reaction palette (mirrors chat-app conventions elsewhere in the industry
 *  and keeps the emoji column indexable/validated rather than free text). */
export const PLAN_MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;
export type PlanMessageReactionEmoji = (typeof PLAN_MESSAGE_REACTIONS)[number];

/** One reaction per (message, buyer) — reacting again with a different emoji
 *  replaces the previous one (see EventPlanMessageService.react). */
export interface IEventPlanMessageReaction extends Document {
  messageId: Types.ObjectId;
  planId: Types.ObjectId; // denormalized for cheap "reactions for these messages" lookups
  buyerId: Types.ObjectId;
  emoji: PlanMessageReactionEmoji;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IEventPlanMessageReaction>(
  {
    messageId: { type: Schema.Types.ObjectId, ref: 'EventPlanMessage', required: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'EventPlan', required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    emoji: { type: String, enum: PLAN_MESSAGE_REACTIONS, required: true },
  },
  { timestamps: true }
);

schema.index({ messageId: 1, buyerId: 1 }, { unique: true });

export const EventPlanMessageReaction = model<IEventPlanMessageReaction>('EventPlanMessageReaction', schema);
