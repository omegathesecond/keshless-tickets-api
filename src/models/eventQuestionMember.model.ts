import mongoose, { Schema, Document, Types } from 'mongoose';

export type QuestionMemberActorType = 'buyer' | 'vendor';

/**
 * A viewer who has explicitly joined a topic (EventQuestion) — required
 * before they may reply or react (see eventQuestion.service#requireMembership,
 * which also treats the topic's own author as an implicit member). Powers the
 * TopicsPage topic cards' member avatars/counts and the Join/Leave Topic flow.
 * `eventId` is denormalized from the parent question (absent for a general
 * "Chat with Everyone" topic) so the main-chat member preview can query
 * directly without joining through EventQuestion, mirroring
 * EventQuestionReply's own eventId denormalization.
 */
export interface IEventQuestionMember extends Document {
  questionId: Types.ObjectId;
  eventId?: Types.ObjectId;
  /** The joining actor's id. Holds a Buyer _id when actorType='buyer', a Vendor _id when 'vendor'. */
  buyerId: Types.ObjectId;
  actorType: QuestionMemberActorType;
  createdAt: Date;
}

const schema = new Schema<IEventQuestionMember>(
  {
    questionId: { type: Schema.Types.ObjectId, ref: 'EventQuestion', required: true, index: true },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: false, index: true },
    buyerId: { type: Schema.Types.ObjectId, required: true, index: true },
    actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One membership per (question, actor). actorType disambiguates the
// (theoretical) case of a Buyer and Vendor sharing an ObjectId value.
schema.index({ questionId: 1, actorType: 1, buyerId: 1 }, { unique: true });

export const EventQuestionMember = mongoose.model<IEventQuestionMember>('EventQuestionMember', schema);
