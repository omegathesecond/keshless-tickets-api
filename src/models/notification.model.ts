import { Schema, model, Document, Types } from 'mongoose';

export type NotificationType =
  | 'announcement'
  | 'dm'
  | 'mention'
  | 'friend'
  | 'event_reminder'
  | 'follow'
  | 'meetup_request'
  | 'meetup_accepted'
  | 'enquiry_received'
  | 'story_like'
  | 'low_stock'
  | 'plan_invite'
  | 'plan_invite_accepted'
  | 'plan_invite_declined'
  | 'plan_join_request'
  | 'plan_join_approved'
  | 'plan_join_declined'
  | 'plan_member_removed'
  | 'plan_message'
  | 'plan_visibility_changed'
  | 'plan_arrangement_updated'
  | 'plan_cancelled'
  | 'vote_opened'
  | 'vote_reminder'
  | 'vote_tag_request'
  | 'vote_tag_response'
  // If I Go… (spec §4/§13) — publish fan-out to followers, a response
  // arriving (grouped: one notification per response event, even if it
  // covers several selected options), and a status change the creator makes
  // flowing back to the respondent.
  | 'if_i_go_posted'
  | 'if_i_go_response'
  | 'if_i_go_status_changed'
  // My Weekend (spec §11-§18) — the status-owner side of every private
  // invite/offer/request kind collapses into one generic type (`data.kind`
  // distinguishes invite_to_event/buy_ticket/buy_drink/invite_to_table/
  // request_join_table/request_to_meet/make_plans_together, same grouping
  // the spec itself uses in §17), the sender's accept/decline notice is a
  // second generic type, and the Friday nudge is a third.
  | 'weekend_request_received'
  | 'weekend_request_responded'
  | 'weekend_reminder';

export type NotificationRecipientType = 'buyer' | 'vendor';

/** One in-app inbox entry. Every push the platform sends is mirrored here
 *  first (spec §6) — the inbox row is the durable record, push is delivery. */
export interface INotification extends Document {
  recipientType: NotificationRecipientType;
  recipientId: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    recipientType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
    recipientId: { type: Schema.Types.ObjectId, required: true },
    type: {
      type: String,
      enum: [
        'announcement',
        'dm',
        'mention',
        'friend',
        'event_reminder',
        'follow',
        'meetup_request',
        'meetup_accepted',
        'enquiry_received',
        'story_like',
        'low_stock',
        'plan_invite',
        'plan_invite_accepted',
        'plan_invite_declined',
        'plan_join_request',
        'plan_join_approved',
        'plan_join_declined',
        'plan_member_removed',
        'plan_message',
        'plan_visibility_changed',
        'plan_arrangement_updated',
        'plan_cancelled',
        'vote_opened',
        'vote_reminder',
        'vote_tag_request',
        'vote_tag_response',
        'if_i_go_posted',
        'if_i_go_response',
        'if_i_go_status_changed',
        'weekend_request_received',
        'weekend_request_responded',
        'weekend_reminder',
      ],
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    body: { type: String, required: true, trim: true, maxlength: 300 },
    data: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date },
  },
  { timestamps: true }
);

// DEPLOY (one-time, SP1b-c): existing rows predate `recipientType` (stored as
// null, since Mongoose's `default: 'buyer'` only applies at insert time and
// is never applied retroactively to rows already in the collection). These
// two indexes and NotificationService.list/markRead query by `recipientType`,
// so the backfill MUST run BEFORE this code is deployed — not just before
// dropping the legacy indexes — or pre-migration buyers will see an empty
// inbox (their rows are keyed null, not 'buyer'). Run:
// `npm run backfill:social-actor-types`
// (src/scripts/backfillSocialActorTypes.ts). It is additive/idempotent and
// safe to run against the old code too.
// Only AFTER the backfill may the legacy indexes be dropped (optional, hygiene):
//   db.notifications.dropIndex('recipientId_1__id_-1')
//   db.notifications.dropIndex('recipientId_1_readAt_1')
notificationSchema.index({ recipientType: 1, recipientId: 1, _id: -1 });
notificationSchema.index({ recipientType: 1, recipientId: 1, readAt: 1 });

// Reminder dedupe: one (event, kind) reminder per recipient, enforced at the
// DB so concurrent sweeps (multi-instance API) can never double-dispatch.
// Partial: only event_reminder rows pay for the index.
notificationSchema.index(
  { recipientId: 1, type: 1, 'data.eventId': 1, 'data.kind': 1 },
  { unique: true, partialFilterExpression: { type: 'event_reminder' } }
);

// Vote notification limits (spec §8): "one notification when the Vote opens"
// and "a maximum of one optional reminder" — both PER (recipient, event),
// never per question. Two separate partial indexes (not one $in-based
// filter — partialFilterExpression doesn't support $in) with explicit names
// so their identical key shape doesn't collide with Mongoose's auto-naming.
notificationSchema.index(
  { recipientId: 1, type: 1, 'data.eventId': 1 },
  { unique: true, partialFilterExpression: { type: 'vote_opened' }, name: 'vote_opened_dedupe' }
);
notificationSchema.index(
  { recipientId: 1, type: 1, 'data.eventId': 1 },
  { unique: true, partialFilterExpression: { type: 'vote_reminder' }, name: 'vote_reminder_dedupe' }
);

// If I Go… publish notification (spec §4): "send only one notification"
// even if the finalize call is retried or several frames publish as one
// sequence — one row per (recipient, story), enforced at the DB same as the
// primary defense-in-depth guard in ifIGo.service#notifyFollowersOfPublish.
notificationSchema.index(
  { recipientId: 1, type: 1, 'data.storyId': 1 },
  { unique: true, partialFilterExpression: { type: 'if_i_go_posted' }, name: 'if_i_go_posted_dedupe' }
);

// My Weekend weekly reminder (spec §18): "one reminder every week" — one row
// per (recipient, weekStart), so a sweep that fires more than once on a
// Friday (see WeekendReminderService — a plain setInterval, not a true cron)
// can never double-send.
notificationSchema.index(
  { recipientId: 1, type: 1, 'data.weekStart': 1 },
  { unique: true, partialFilterExpression: { type: 'weekend_reminder' }, name: 'weekend_reminder_dedupe' }
);

export const Notification = model<INotification>('Notification', notificationSchema);
