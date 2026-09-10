import { Schema, model, Document, Types } from 'mongoose';

export type AccountActivityKind = 'profile_view' | 'story_view' | 'post_view' | 'unfollow';
export type AccountActivityActorType = 'buyer' | 'vendor';

/**
 * One raw "someone did something to my account" event — the source data for
 * the My Account tab (spec: Activity page, tab 2 of 3). Distinct from
 * Notification (@models/notification.model): a Notification is an addressed
 * inbox row for a fixed action (a like, a DM, a follow); THIS is a passive
 * insight (a view) that must be groupable ("Thulas viewed your Story 3
 * times") rather than delivered as N separate rows. Kept in its own
 * collection instead of overloading Notification because the two have
 * different read models (grouped-by-actor vs one row per action) and must
 * never leak into each other's UI surface (spec §2).
 *
 * Scoped to buyer-owned targets only: `ownerId` is always a Buyer — the
 * consumer "My Account" tab is a personal-account surface. Organizer brands
 * have their own analytics elsewhere; this collection never carries a
 * vendor owner.
 *
 * One row per genuine occurrence, throttled at write time (see
 * AccountActivityService.THROTTLE_MS) so a page refresh doesn't inflate the
 * count — NOT deduped to a single row with a counter, because the read side
 * needs each occurrence's own timestamp to report "most recent action" and
 * because story_view rows piggyback 1:1 on StorySeen's own once-per-(story,
 * viewer) row, which already IS the natural unit of "a view".
 */
export interface IAccountActivityEvent extends Document {
  ownerId: Types.ObjectId;
  actorType: AccountActivityActorType;
  actorId: Types.ObjectId;
  kind: AccountActivityKind;
  /** Story or Update id for story_view/post_view; absent for profile_view/unfollow. */
  targetId?: Types.ObjectId;
  /** Null = unread. Set when the owner opens this event's group in the My
   *  Account tab, or via "Mark all as read". */
  readAt: Date | null;
  /** Null = not yet folded into a grouped push digest. Set by
   *  AccountActivityDigestService.sweep so the same event is never announced
   *  twice. Independent of readAt — opening the tab and a digest push are
   *  two different "has this been surfaced" questions. */
  pushedAt: Date | null;
  createdAt: Date;
}

const accountActivityEventSchema = new Schema<IAccountActivityEvent>(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true },
    actorType: { type: String, enum: ['buyer', 'vendor'], required: true, default: 'buyer' },
    actorId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ['profile_view', 'story_view', 'post_view', 'unfollow'], required: true },
    targetId: { type: Schema.Types.ObjectId },
    readAt: { type: Date, default: null },
    pushedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Owner's feed, newest first — the primary read path (list + group).
accountActivityEventSchema.index({ ownerId: 1, createdAt: -1 });
// Unread-count / mark-all-read.
accountActivityEventSchema.index({ ownerId: 1, readAt: 1 });
// Write-side throttle lookup: "did this actor already do this to this owner
// (for this target, if any) recently?" — see AccountActivityService.record.
accountActivityEventSchema.index({ ownerId: 1, actorType: 1, actorId: 1, kind: 1, targetId: 1, createdAt: -1 });
// Digest sweep: unpushed rows across all owners.
accountActivityEventSchema.index({ pushedAt: 1, kind: 1 });

export const AccountActivityEvent = model<IAccountActivityEvent>('AccountActivityEvent', accountActivityEventSchema);
