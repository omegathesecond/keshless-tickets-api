import { Buyer } from '@models/buyer.model';
import { Notification } from '@models/notification.model';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { currentWeekendWindow } from '@utils/weekendWindow.util';

/**
 * Weekly "what are you doing this weekend?" reminder (spec §18). Sent once
 * per buyer per weekend, on Friday.
 *
 * Two documented simplifications versus the literal spec:
 *  1. "Friday using each user's local timezone" — Buyer has no stored
 *     timezone/UTC-offset field (see @utils/weekendWindow.util's doc
 *     comment), so this gates on UTC Friday, a single global day rather than
 *     a genuine per-user local one. A real per-timezone reminder needs a new
 *     Buyer field first — tracked as a follow-up, not silently faked.
 *  2. There is no cron/day-of-week scheduler anywhere in this codebase (see
 *     backgroundTasks.ts) — every sweep is a plain `setInterval` that
 *     self-gates on the current time. This sweep does the same: it runs
 *     every REMINDER interval tick but only actually sends on Fridays.
 */
export class WeekendReminderService {
  static async sweep(): Promise<void> {
    const now = new Date();
    if (now.getUTCDay() !== 5) return; // Friday only

    const weekStart = currentWeekendWindow(now).start.toISOString();
    const already = await Notification.find({ type: 'weekend_reminder', 'data.weekStart': weekStart }).distinct('recipientId');
    const alreadySet = new Set(already.map(String));

    // notificationPrefs.reminders !== false doubles as "weekly reminders
    // enabled" (spec §18 "provide a setting to disable weekly reminders") —
    // the same toggle event_reminder already uses, so no new Buyer field is
    // needed just for this.
    const buyers = await Buyer.find({ 'notificationPrefs.reminders': { $ne: false } }).select('_id');
    const recipientIds = buyers.map((b) => String(b._id)).filter((id) => !alreadySet.has(id));
    if (recipientIds.length === 0) return;

    await NotificationDispatcher.dispatch(
      recipientIds,
      'weekend_reminder',
      'What are you doing this weekend?',
      'Update your My Weekend status and let people make plans with you.',
      { weekStart }
    );
  }
}
