import { AccountActivityEvent, AccountActivityKind } from '@models/accountActivityEvent.model';
import { PushService } from '@services/push.service';

/** Only these three kinds are "you were looked at" insights worth a grouped
 *  push (spec §5 examples: "3 people viewed your profile", "Your Story
 *  received 12 views"). unfollow is excluded deliberately — spec's grouped-
 *  summary examples are both view counts, and an "N people unfollowed you
 *  today" push would be actively unpleasant to receive; unfollow rows still
 *  show up in the My Account tab itself (spec §1), just never pushed. */
const PUSHABLE_KINDS: AccountActivityKind[] = ['profile_view', 'story_view', 'post_view'];

/** Minimum age before an event is eligible for a digest push — batches a
 *  burst of views into one summary instead of racing the sweep interval and
 *  shipping a "1 person viewed your profile" push per person. Paired with
 *  the sweep's own cadence (backgroundTasks.ts), this is what makes "today"
 *  in the push copy roughly true without needing a calendar-day cron. */
const MIN_AGE_MS = 30 * 60 * 1000;

function summaryLine(kind: AccountActivityKind, distinctActors: number, totalViews: number): string {
  switch (kind) {
    case 'profile_view':
      return `${distinctActors} ${distinctActors === 1 ? 'person' : 'people'} viewed your profile today`;
    case 'story_view':
      return `Your Story received ${totalViews} view${totalViews === 1 ? '' : 's'} today`;
    case 'post_view':
      return `Your posts received ${totalViews} view${totalViews === 1 ? '' : 's'} today`;
    case 'unfollow':
      return ''; // unreachable — see PUSHABLE_KINDS
  }
}

export class AccountActivityDigestService {
  /**
   * Grouped push digest (spec §5): "Do not send a separate push alert for
   * every profile, Story or post view. Send grouped summaries instead."
   * ONE push per owner per sweep, covering every unpushed eligible event,
   * deep-linking to the My Account tab (never the notifications panel) —
   * see `data.deepLink` below, read by the service worker's notificationclick
   * handler the same way every other push payload here is.
   *
   * Never touches the Notification inbox (@models/notification.model) —
   * this is delivery-only, exactly like every other PushService call; the
   * My Account tab itself is the durable, in-app record (spec §1).
   */
  static async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - MIN_AGE_MS);
    const ownerIds = await AccountActivityEvent.distinct('ownerId', {
      pushedAt: null,
      kind: { $in: PUSHABLE_KINDS },
      createdAt: { $lte: cutoff },
    });

    for (const ownerId of ownerIds) {
      try {
        const events = await AccountActivityEvent.find({
          ownerId,
          pushedAt: null,
          kind: { $in: PUSHABLE_KINDS },
          createdAt: { $lte: cutoff },
        }).select('_id kind actorId');
        if (events.length === 0) continue;

        const byKind = new Map<AccountActivityKind, { actorIds: Set<string>; total: number }>();
        for (const e of events) {
          const bucket = byKind.get(e.kind) ?? { actorIds: new Set<string>(), total: 0 };
          bucket.actorIds.add(String(e.actorId));
          bucket.total += 1;
          byKind.set(e.kind, bucket);
        }

        const lines = PUSHABLE_KINDS.filter((k) => byKind.has(k)).map((k) => {
          const bucket = byKind.get(k)!;
          return summaryLine(k, bucket.actorIds.size, bucket.total);
        });
        if (lines.length === 0) continue;

        await PushService.sendToBuyer(String(ownerId), {
          title: 'New activity on your account',
          body: lines.join(' · '),
          data: { type: 'account_activity', deepLink: '/activity?tab=my-account' },
        });

        await AccountActivityEvent.updateMany(
          { _id: { $in: events.map((e) => e._id) } },
          { $set: { pushedAt: new Date() } }
        );
      } catch (err) {
        // Per-owner isolation, same convention as NotificationDispatcher.dispatch:
        // one buyer's push failure must never stall the rest of the sweep.
        console.error(`[account-activity-digest] owner ${String(ownerId)} failed:`, err);
      }
    }
  }
}
