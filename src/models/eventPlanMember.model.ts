import { Schema, model, Document, Types } from 'mongoose';

export type PlanMemberRole = 'admin' | 'member';
/**
 * 'invited'   — admin sent an invitation, awaiting the invitee's response.
 * 'requested' — buyer asked to join a 'request' policy public plan, awaiting admin.
 * 'accepted'  — full member (invite accepted, request approved, or joined an 'open' public plan).
 * 'declined'  — invitee declined, or admin declined a join request.
 * 'removed'   — admin removed an accepted member.
 * 'left'      — member left voluntarily.
 */
export type PlanMemberStatus = 'invited' | 'requested' | 'accepted' | 'declined' | 'removed' | 'left';
export type PlanAttendanceStatus = 'going' | 'maybe' | 'cant_go' | 'unset';

/**
 * One row per (plan, buyer) for the LIFETIME of that pairing — re-inviting a
 * declined/removed/left buyer flips the same row back to 'invited' rather
 * than creating a second row (mirrors MeetupRequest's re-request behavior),
 * which is what the unique index below enforces.
 *
 * Only status='accepted' rows count as members for access control, the
 * member list, attendance and the conversation (spec §3/§4/§8/§9).
 */
export interface IEventPlanMember extends Document {
  planId: Types.ObjectId;
  buyerId: Types.ObjectId;
  role: PlanMemberRole;
  status: PlanMemberStatus;
  invitedBy?: Types.ObjectId; // admin who sent the invite (absent for self-requested/self-joined rows)
  attendance: PlanAttendanceStatus;
  attendanceUpdatedAt?: Date;
  respondedAt?: Date; // invite accepted/declined, or join request approved/declined
  joinedAt?: Date; // became 'accepted'
  removedAt?: Date;
  leftAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const eventPlanMemberSchema = new Schema<IEventPlanMember>(
  {
    planId: { type: Schema.Types.ObjectId, ref: 'EventPlan', required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    role: { type: String, enum: ['admin', 'member'], required: true, default: 'member' },
    status: { type: String, enum: ['invited', 'requested', 'accepted', 'declined', 'removed', 'left'], required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'Buyer' },
    attendance: { type: String, enum: ['going', 'maybe', 'cant_go', 'unset'], required: true, default: 'unset' },
    attendanceUpdatedAt: { type: Date },
    respondedAt: { type: Date },
    joinedAt: { type: Date },
    removedAt: { type: Date },
    leftAt: { type: Date },
  },
  { timestamps: true }
);

// One row per (plan, buyer) ever — see class doc above.
eventPlanMemberSchema.index({ planId: 1, buyerId: 1 }, { unique: true });
// Member list / access checks: accepted members of a plan.
eventPlanMemberSchema.index({ planId: 1, status: 1 });
// "My Plans" (upcoming/past/invitations) and "My Invitations" — a buyer's rows by status, newest first.
eventPlanMemberSchema.index({ buyerId: 1, status: 1, _id: -1 });

export const EventPlanMember = model<IEventPlanMember>('EventPlanMember', eventPlanMemberSchema);
