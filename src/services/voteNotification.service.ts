import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { Follow } from '@models/follow.model';
import { EventReaction } from '@models/eventReaction.model';
import { Community } from '@models/community.model';
import { Membership } from '@models/membership.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { Buyer } from '@models/buyer.model';
import { Notification } from '@models/notification.model';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { getVoteWindow } from '@utils/voteWindow.util';
import { ensureVoteQuestions } from '@services/vote.service';

/** How long before Vote closes the single optional reminder may fire. */
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Everyone spec §8 says to notify when a Vote opens/reminds: the event's
 * organizer followers, buyers who saved the event, buyers "going" (joined
 * its community OR hold a live ticket), and confirmed ticket holders.
 * Deduped into one buyer-id set — a buyer in three of those groups still
 * gets exactly one notification (the dedupe index also guarantees that, but
 * there's no reason to even attempt the duplicate insert).
 */
async function resolveRecipients(event: any): Promise<string[]> {
  const eventId = event._id;
  const ids = new Set<string>();

  if (event.vendorId) {
    const followers = await Follow.find({ targetType: 'organizer', targetId: event.vendorId, followerType: 'buyer' })
      .select('followerId')
      .lean();
    for (const f of followers) ids.add(String(f.followerId));
  }

  const savers = await EventReaction.find({ eventId, type: 'save', actorType: 'buyer' }).select('buyerId').lean();
  for (const s of savers) ids.add(String(s.buyerId));

  const community = await Community.findOne({ eventId }).select('_id').lean();
  if (community) {
    const members = await Membership.find({ communityId: (community as any)._id, buyerId: { $exists: true }, bannedAt: { $exists: false } })
      .select('buyerId')
      .lean();
    for (const m of members) if (m.buyerId) ids.add(String(m.buyerId));
  }

  const phones = await Ticket.distinct('customerPhone', { eventId, status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] } });
  if (phones.length > 0) {
    const holders = await Buyer.find({ phone: { $in: phones.filter(Boolean) } }).select('_id').lean();
    for (const h of holders) ids.add(String(h._id));
  }

  return [...ids];
}

async function alreadyNotified(type: 'vote_opened' | 'vote_reminder', eventId: string): Promise<Set<string>> {
  const rows = await Notification.find({ type, 'data.eventId': eventId }).select('recipientId').lean();
  return new Set(rows.map((r: any) => String(r.recipientId)));
}

export class VoteNotificationService {
  /**
   * Periodic sweep (spec §8): "send one notification when the Vote opens"
   * and "allow a maximum of one optional reminder before voting closes" — a
   * single per-event notification of each kind, never repeated and never
   * per-question. Dedup is durable via the partial unique indexes on
   * Notification (notification.model.ts), the same pattern
   * EventReminderService uses — the `alreadyNotified` read here is a
   * pre-filter to avoid needless dispatch attempts, not the source of truth.
   */
  static async sweep(): Promise<void> {
    const now = new Date();
    const events = await Event.find({ status: EventStatus.PUBLISHED, publishedAt: { $ne: null } });

    for (const event of events) {
      const window = getVoteWindow(event as any, now);
      if (!window.hasOpened || window.hasClosed) continue;

      const eventId = String(event._id);
      await ensureVoteQuestions(event as any);

      const recipients = await resolveRecipients(event);
      if (recipients.length === 0) continue;

      const openedAlready = await alreadyNotified('vote_opened', eventId);
      const toOpen = recipients.filter((id) => !openedAlready.has(id));
      if (toOpen.length > 0) {
        const name = event.name.length > 100 ? `${event.name.slice(0, 99)}…` : event.name;
        await NotificationDispatcher.dispatch(toOpen, 'vote_opened', 'Vote is open 🗳️', `Vote is live for ${name} — have your say`, { eventId });
      }

      const msRemaining = window.closesAt.getTime() - now.getTime();
      if (msRemaining <= REMINDER_WINDOW_MS) {
        const remindedAlready = await alreadyNotified('vote_reminder', eventId);
        const toRemind = recipients.filter((id) => !remindedAlready.has(id));
        if (toRemind.length > 0) {
          const name = event.name.length > 100 ? `${event.name.slice(0, 99)}…` : event.name;
          await NotificationDispatcher.dispatch(toRemind, 'vote_reminder', 'Last chance to Vote 🗳️', `Voting for ${name} closes soon`, { eventId });
        }
      }
    }
  }
}
