import { Schema, model, Document, Types } from 'mongoose';
import { WeekendRequestKind, WeekendRequestStatus, WEEKEND_REQUEST_KINDS, WEEKEND_REQUEST_STATUSES, WEEKEND_REQUEST_MESSAGE_MAXLEN } from '@interfaces/weekend.interface';

/**
 * A private My-Weekend request/offer between two buyers (spec §11-§16):
 * invite to an event, buy a ticket/drink, invite to or request to join a
 * table, request to meet, or "make plans together". Unlike MeetupRequest
 * (one row per direction pair, reused across repeat requests) this is
 * APPEND-ONLY — a sender can have several DISTINCT open requests to the same
 * recipient (e.g. invited to two different events), so a compound unique
 * index would be wrong here. Duplicate-pending prevention (same
 * sender+recipient+kind+event still pending) is a narrower check in
 * WeekendService.createRequest instead.
 */
export interface IWeekendRequest extends Document {
  senderId: Types.ObjectId;
  recipientId: Types.ObjectId;
  kind: WeekendRequestKind;
  status: WeekendRequestStatus;
  eventId?: Types.ObjectId;
  eventPlanId?: Types.ObjectId;
  weekendStatusId?: Types.ObjectId;
  message?: string;
  respondedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const weekendRequestSchema = new Schema<IWeekendRequest>(
  {
    senderId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true },
    kind: { type: String, enum: WEEKEND_REQUEST_KINDS, required: true },
    status: { type: String, enum: WEEKEND_REQUEST_STATUSES, required: true, default: 'pending' },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event' },
    eventPlanId: { type: Schema.Types.ObjectId, ref: 'EventPlan' },
    weekendStatusId: { type: Schema.Types.ObjectId, ref: 'WeekendStatus' },
    message: { type: String, trim: true, maxlength: WEEKEND_REQUEST_MESSAGE_MAXLEN },
    respondedAt: { type: Date },
  },
  { timestamps: true }
);

// Incoming/outgoing tabs, newest first.
weekendRequestSchema.index({ recipientId: 1, status: 1, _id: -1 });
weekendRequestSchema.index({ senderId: 1, status: 1, _id: -1 });

export const WeekendRequest = model<IWeekendRequest>('WeekendRequest', weekendRequestSchema);
