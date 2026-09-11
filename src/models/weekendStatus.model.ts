import { Schema, model, Document, Types } from 'mongoose';
import { WeekendStatusType, WeekendAudience, WEEKEND_STATUS_TYPES, WEEKEND_AUDIENCES, WEEKEND_MESSAGE_MAXLEN } from '@interfaces/weekend.interface';

/**
 * "My Weekend" status — ONE row per buyer, upserted on every update/renew.
 * Deliberately not append-only: spec says a buyer may "update, replace or
 * remove their status at any time" — there is only ever one CURRENT status,
 * so a second write replaces the first rather than creating a history row.
 *
 * `activeUntil` is the single field every "is this still showing" query
 * filters on (`activeUntil: { $gt: now }`): a general status gets
 * `weekendEnd`; an event-linked status instead gets the event's `endTime`
 * (spec §19's two different expiry rules collapsed into one comparable
 * field) — see WeekendService.upsertStatus for how it's computed, and
 * WeekendService.sweepCancelledEventLinks for what happens when the linked
 * event itself gets cancelled/deleted.
 */
export interface IWeekendStatus extends Document {
  buyerId: Types.ObjectId;
  statusType: WeekendStatusType;
  message?: string;
  eventId?: Types.ObjectId;
  audience: WeekendAudience;
  /** Only meaningful when audience='selected'. */
  selectedViewerIds: Types.ObjectId[];
  weekendStart: Date;
  weekendEnd: Date;
  activeUntil: Date;
  createdAt: Date;
  updatedAt: Date;
}

const weekendStatusSchema = new Schema<IWeekendStatus>(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'Buyer', required: true, unique: true },
    statusType: { type: String, enum: WEEKEND_STATUS_TYPES, required: true },
    message: { type: String, trim: true, maxlength: WEEKEND_MESSAGE_MAXLEN },
    eventId: { type: Schema.Types.ObjectId, ref: 'Event' },
    audience: { type: String, enum: WEEKEND_AUDIENCES, required: true, default: 'public' },
    selectedViewerIds: { type: [Schema.Types.ObjectId], default: [] },
    weekendStart: { type: Date, required: true },
    weekendEnd: { type: Date, required: true },
    activeUntil: { type: Date, required: true },
  },
  { timestamps: true }
);

// "Who Has Plans This Weekend" / "Looking for Plans" home-feed queries: active
// rows only, most-recently-updated first (so a renewed/edited status resurfaces).
weekendStatusSchema.index({ activeUntil: 1, updatedAt: -1 });
// Event-linked status lookups (event cancelled/ended sweep, "who else is going").
weekendStatusSchema.index({ eventId: 1, activeUntil: 1 });

export const WeekendStatus = model<IWeekendStatus>('WeekendStatus', weekendStatusSchema);
