import { Schema, model, Document, Types } from 'mongoose';

export type ReportTargetType = 'message' | 'buyer' | 'update' | 'story';
export type ReportStatus = 'open' | 'resolved' | 'dismissed';

/**
 * A buyer-filed report against a channel message, another buyer, or a
 * Discover feed update (Plan 7 Task 3 — platform-wide social moderation
 * queue, tickets:moderate_social admin-only; 'update' added in Task 12 for
 * the Discover feed; 'story' added for If I Go… — spec §16 "allow users to
 * report inappropriate options, responses or messages" for a Story, its
 * custom response options, or the poll overall). Exactly one of
 * messageId/targetBuyerId/targetUpdateId/targetStoryId is set, matching
 * targetType — same exactly-one-container shape as Message's
 * channelId/dmThreadId invariant (see message.model.ts).
 *
 * Dedupe: a reporter can only have ONE OPEN report against the same
 * message/buyer/update at a time. Enforced by the partial unique indexes
 * below (mirrors notification.model.ts's event-reminder dedupe pattern) —
 * once a report is resolved/dismissed (status leaves 'open'), the reporter
 * is free to file again. The `$exists` guard on each partial filter keeps
 * the target shapes from colliding with each other's absent field (an open
 * buyer-target report has no messageId, and vice versa).
 */
export interface IReport extends Document {
  reporterId: Types.ObjectId;
  targetType: ReportTargetType;
  messageId?: Types.ObjectId;
  targetBuyerId?: Types.ObjectId;
  targetUpdateId?: Types.ObjectId;
  targetStoryId?: Types.ObjectId;
  reason: string;
  status: ReportStatus;
  resolvedBy?: string; // ticketsUser id (vendorId or sub-user userId) — plain string, mirrors approvedBy on resellerCommissionWithdrawal.model.ts (not a single Mongoose ref: super-admin tokens carry no real vendor row)
  resolvedAt?: Date;
  resolutionNote?: string;
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new Schema<IReport>(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, index: true },
    targetType: { type: String, enum: ['message', 'buyer', 'update', 'story'], required: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    targetBuyerId: { type: Schema.Types.ObjectId, ref: 'Buyer' },
    targetUpdateId: { type: Schema.Types.ObjectId, ref: 'Update' },
    targetStoryId: { type: Schema.Types.ObjectId, ref: 'Story' },
    reason: { type: String, required: true, trim: true, minlength: 1, maxlength: 500 },
    status: { type: String, enum: ['open', 'resolved', 'dismissed'], required: true, default: 'open' },
    resolvedBy: { type: String },
    resolvedAt: { type: Date },
    resolutionNote: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

// Maps each targetType to the one id field it must carry — the exactly-one-
// target invariant below walks this instead of a fixed pair of booleans so
// adding a future targetType only means adding one entry here.
const TARGET_ID_FIELDS: Record<ReportTargetType, 'messageId' | 'targetBuyerId' | 'targetUpdateId' | 'targetStoryId'> = {
  message: 'messageId',
  buyer: 'targetBuyerId',
  update: 'targetUpdateId',
  story: 'targetStoryId',
};

// Exactly one target per report, matching its targetType.
reportSchema.pre('validate', function (next) {
  const presence: Record<'messageId' | 'targetBuyerId' | 'targetUpdateId' | 'targetStoryId', boolean> = {
    messageId: Boolean(this.messageId),
    targetBuyerId: Boolean(this.targetBuyerId),
    targetUpdateId: Boolean(this.targetUpdateId),
    targetStoryId: Boolean(this.targetStoryId),
  };
  const presentFields = (Object.keys(presence) as Array<keyof typeof presence>).filter((k) => presence[k]);
  if (presentFields.length !== 1) {
    return next(new Error('Report must have exactly one of messageId, targetBuyerId or targetUpdateId'));
  }

  const requiredField = TARGET_ID_FIELDS[this.targetType];
  if (!requiredField || !presence[requiredField]) {
    return next(new Error(`targetType '${this.targetType}' requires ${requiredField}`));
  }
  next();
});

// Admin queue: GET /api/tickets/reports?status=open&before&limit.
reportSchema.index({ status: 1, createdAt: -1 });

reportSchema.index(
  { reporterId: 1, messageId: 1 },
  { unique: true, partialFilterExpression: { status: 'open', messageId: { $exists: true } } }
);
reportSchema.index(
  { reporterId: 1, targetBuyerId: 1 },
  { unique: true, partialFilterExpression: { status: 'open', targetBuyerId: { $exists: true } } }
);
reportSchema.index(
  { reporterId: 1, targetUpdateId: 1 },
  { unique: true, partialFilterExpression: { status: 'open', targetUpdateId: { $exists: true } } }
);
reportSchema.index(
  { reporterId: 1, targetStoryId: 1 },
  { unique: true, partialFilterExpression: { status: 'open', targetStoryId: { $exists: true } } }
);

export const Report = model<IReport>('Report', reportSchema);
