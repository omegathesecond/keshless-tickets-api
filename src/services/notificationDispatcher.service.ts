import { Buyer, NotificationPrefs } from '@models/buyer.model';
import { NotificationType } from '@models/notification.model';
import { NotificationService } from '@services/notification.service';
import { PushService } from '@services/push.service';
import { BlockService } from '@services/block.service';
import { isBuyerOnline } from '@utils/buyerOnline.util';

export const PREF_BY_TYPE: Record<NotificationType, keyof NotificationPrefs> = {
  announcement: 'announcements',
  dm: 'dms',
  mention: 'mentions',
  friend: 'social',
  event_reminder: 'reminders',
  // Vendor follow notifications bypass this buyer dispatcher entirely (written
  // directly via NotificationService.create — see SP1b-c Task 2); 'social' is
  // the closest existing pref bucket, kept only for Record<NotificationType,…>
  // exhaustiveness.
  follow: 'social',
  meetup_request: 'social',
  meetup_accepted: 'social',
  // Enquiries also bypass this buyer dispatcher — the recipient is the vendor
  // inbox (EnquiryService.create writes via NotificationService.create
  // directly), so this entry exists only for Record<NotificationType,…>
  // exhaustiveness.
  enquiry_received: 'social',
  story_like: 'social',
  // Vendor low-stock alerts bypass this buyer dispatcher entirely (written
  // directly via NotificationService.create — see cashless stock Slice 3
  // Task 1); 'social' is the closest existing pref bucket, kept only for
  // Record<NotificationType,…> exhaustiveness.
  low_stock: 'social',
  // Vote notifications (opened/reminder/tag request/tag response) bypass this
  // buyer dispatcher for the tag flows (written directly via
  // NotificationService.create from vote.service, same as meetup/enquiry
  // above) but DO go through here for vote_opened/vote_reminder fan-out
  // (@services/voteNotification.service). 'social' is the closest existing
  // pref bucket for all four; kept for Record<NotificationType,…> exhaustiveness.
  vote_opened: 'social',
  vote_reminder: 'social',
  vote_tag_request: 'social',
  vote_tag_response: 'social',
};

const CHUNK = 50;

export class NotificationDispatcher {
  /**
   * The single notification funnel (spec §6): per-category prefs decide
   * whether anything happens at all; the inbox row is the durable record;
   * push goes only to OFFLINE buyers (gateway presence).
   */
  static async dispatch(
    recipientIds: string[],
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown>,
    actorId?: string
  ): Promise<void> {
    const prefKey = PREF_BY_TYPE[type];
    const unique = [...new Set(recipientIds.map(String))];

    let filtered = unique;
    if (actorId) {
      // A blocked relationship in EITHER direction must never generate a
      // notification (harassment vector once the inbox/push surfaces ship).
      const [blockedByActor, blockedActor] = await Promise.all([
        BlockService.listBlockedIds(actorId),
        BlockService.listBlockerIds(actorId),
      ]);
      const excluded = new Set([...blockedByActor, ...blockedActor]);
      filtered = unique.filter((id) => !excluded.has(id));
    }

    for (let i = 0; i < filtered.length; i += CHUNK) {
      const chunk = filtered.slice(i, i + CHUNK);
      const buyers = await Buyer.find({ _id: { $in: chunk } }).select('notificationPrefs');
      await Promise.all(
        buyers.map(async (buyer) => {
          try {
            if (buyer.notificationPrefs?.[prefKey] === false) return; // toggled off — no inbox, no push
            const id = String(buyer._id);
            await NotificationService.create('buyer', id, type, title, body, data);
            if (!(await isBuyerOnline(id))) {
              await PushService.sendToBuyer(id, { title, body, data: { ...data, type } });
            }
          } catch (err) {
            // Per-recipient isolation: one failure must never drop the rest
            // of the fan-out. Loud, then continue.
            console.error(`[notify] recipient ${String(buyer._id)} failed:`, err);
          }
        })
      );
    }
  }

  /** Fire-and-forget for request paths: notifications must never fail or
   *  slow the triggering write. Failures are loud in logs. */
  static dispatchAsync(
    recipientIds: string[],
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown>,
    actorId?: string
  ): void {
    NotificationDispatcher.dispatch(recipientIds, type, title, body, data, actorId).catch((err) =>
      console.error('[notify] dispatch failed:', err)
    );
  }
}
