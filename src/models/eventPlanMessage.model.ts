import { Schema, model, Document, Types } from 'mongoose';

/**
 * A message inside a plan's conversation (spec §9). Text-only for v1 — image
 * sharing is intentionally deferred (no upload infra exists for plan
 * messages yet; see the "plan image sharing" follow-up).
 */
export interface IEventPlanMessage extends Document {
  planId: Types.ObjectId;
  senderId: Types.ObjectId;
  body: string;
  replyTo?: Types.ObjectId;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const eventPlanMessageSchema = new Schema<IEventPlanMessage>(
  {
    planId: { type: Schema.Types.ObjectId, ref: 'EventPlan', required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    body: { type: String, required: true, trim: true, minlength: 1, maxlength: 2000 },
    replyTo: { type: Schema.Types.ObjectId, ref: 'EventPlanMessage' },
    deletedAt: { type: Date },
  },
  { timestamps: true }
);

// Cursor pagination: newest-first within a plan.
eventPlanMessageSchema.index({ planId: 1, _id: -1 });

export const EventPlanMessage = model<IEventPlanMessage>('EventPlanMessage', eventPlanMessageSchema);
