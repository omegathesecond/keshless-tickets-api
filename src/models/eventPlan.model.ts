import { Schema, model, Document, Types } from 'mongoose';

export type PlanVisibility = 'public' | 'private';
/** Only meaningful when visibility='public' — a private plan is always invite-only. */
export type PlanJoinPolicy = 'open' | 'request';
export type PlanStatus = 'active' | 'cancelled';

export interface IPlanTransportInfo {
  method?: string;
  provider?: string;
  seats?: number;
  costEstimate?: number;
  notes?: string;
}

/**
 * "Plans With Friends" — a group plan a buyer creates around one event to
 * coordinate meeting up, voting attendance, chatting and arranging transport
 * with invited (or, if public, self-joined) friends.
 *
 * Visibility is the single access-control switch (spec §3/§4): 'private'
 * plans are invitation-only everywhere (event page, search, profiles); a
 * 'public' plan is readable by anyone viewing the event, but only accepted
 * members (EventPlanMember status='accepted') may write to it. See
 * EventPlanService.assertViewAccess / assertMemberAccess for the enforcement.
 */
export interface IEventPlan extends Document {
  eventId: Types.ObjectId;
  adminId: Types.ObjectId; // creator, always also an EventPlanMember with role='admin'
  name: string;
  description?: string;
  visibility: PlanVisibility;
  joinPolicy: PlanJoinPolicy;
  status: PlanStatus;
  meetingPoint?: string;
  meetingTime?: Date;
  /** Distinguishes an admin-confirmed arrangement from a member's suggestion (spec §10). */
  meetingConfirmed: boolean;
  transport?: IPlanTransportInfo;
  transportConfirmed: boolean;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const transportSchema = new Schema<IPlanTransportInfo>(
  {
    method: { type: String, trim: true, maxlength: 60 },
    provider: { type: String, trim: true, maxlength: 100 },
    seats: { type: Number, min: 0 },
    costEstimate: { type: Number, min: 0 },
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const eventPlanSchema = new Schema<IEventPlan>(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
    adminId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 1000 },
    visibility: { type: String, enum: ['public', 'private'], required: true, default: 'public' },
    joinPolicy: { type: String, enum: ['open', 'request'], required: true, default: 'open' },
    status: { type: String, enum: ['active', 'cancelled'], required: true, default: 'active' },
    meetingPoint: { type: String, trim: true, maxlength: 200 },
    meetingTime: { type: Date },
    meetingConfirmed: { type: Boolean, default: false },
    transport: { type: transportSchema },
    transportConfirmed: { type: Boolean, default: false },
    cancelledAt: { type: Date },
  },
  { timestamps: true }
);

// Public "Plans With Friends" section on the event page: active, public plans
// for an event, newest first.
eventPlanSchema.index({ eventId: 1, visibility: 1, status: 1, _id: -1 });
// Admin's own plans (My Plans → manage).
eventPlanSchema.index({ adminId: 1, status: 1, _id: -1 });

export const EventPlan = model<IEventPlan>('EventPlan', eventPlanSchema);
