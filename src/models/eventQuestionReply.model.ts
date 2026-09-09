import mongoose, { Schema, Document, Types } from 'mongoose';
import type { SocialActorType } from '@utils/socialActor.util';

/**
 * A reply on one EventQuestion thread. Carries its own eventId (denormalized
 * off the parent question at write time) so a reply can be looked up or
 * reported without a join back through EventQuestion. Absent when the parent
 * question is a general "Chat with Everyone" post (no event).
 */
export interface IEventQuestionReply extends Document {
  questionId: Types.ObjectId;
  eventId?: Types.ObjectId;
  authorType: SocialActorType;
  authorId: Types.ObjectId;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IEventQuestionReply>(
  {
    questionId: { type: Schema.Types.ObjectId, ref: 'EventQuestion', required: true, index: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: false },
    authorType: { type: String, enum: ['buyer', 'vendor'], required: true },
    authorId: { type: Schema.Types.ObjectId, required: true },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { timestamps: true },
);

// Serves "replies for this question, oldest first" — the thread read order.
schema.index({ questionId: 1, createdAt: 1 });

export const EventQuestionReply = mongoose.model<IEventQuestionReply>('EventQuestionReply', schema);
