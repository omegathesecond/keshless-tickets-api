import { Notification, INotification, NotificationType, NotificationRecipientType } from '@models/notification.model';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';

/** The person/brand a notification is *about* — who followed you, who messaged
 *  you — resolved at read-time so the row can show their avatar instead of a
 *  generic glyph. `type` mirrors the frontend's routing vocabulary
 *  (buyer → /u, organizer → /o). Null when no actor can be resolved (system
 *  reminders, or legacy payloads that never carried an actor id). */
export interface NotificationActor {
  type: 'buyer' | 'organizer';
  id: string;
  name: string;
  avatarUrl: string | null;
  /** Buyers only — lets the client prefer the /u/:username route. */
  username: string | null;
}

export interface NotificationView {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: Date;
  actor: NotificationActor | null;
}

/** Which buyer/vendor a notification points at, derived from its payload.
 *  A generic `{ actorId, actorType }` pair (written by newer dispatch sites)
 *  wins; otherwise fall back to the per-type fields the follow/friend paths
 *  have always carried, so EXISTING rows hydrate too — no backfill needed. */
type ActorRef = { kind: 'buyer' | 'vendor'; id: string };
/** A well-formed Mongo id — anything else is a legacy/test payload and must be
 *  skipped, never fed to `$in` (a bad cast would 500 the whole inbox for a
 *  merely-missing avatar). */
const isObjectId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v);
function actorRef(type: NotificationType, data: Record<string, unknown>): ActorRef | null {
  const gtype = data.actorType;
  if (isObjectId(data.actorId) && (gtype === 'buyer' || gtype === 'vendor')) return { kind: gtype, id: data.actorId };
  if (type === 'follow' && isObjectId(data.followerId))
    return { kind: data.followerType === 'organizer' ? 'vendor' : 'buyer', id: data.followerId };
  // friend + meetup + enquiry rows all carry the acting buyer as `data.buyerId`
  // (requester on meetup_request, accepter on meetup_accepted, enquirer on enquiry_received).
  if ((type === 'friend' || type === 'meetup_request' || type === 'meetup_accepted' || type === 'enquiry_received') && isObjectId(data.buyerId))
    return { kind: 'buyer', id: data.buyerId };
  // enquiry_received carries the enquiring buyer the same way.
  if (type === 'enquiry_received' && isObjectId(data.buyerId)) return { kind: 'buyer', id: data.buyerId };
  return null;
}

export class NotificationService {
  static async create(
    recipientType: NotificationRecipientType,
    recipientId: string,
    type: NotificationType,
    title: string,
    body: string,
    data: Record<string, unknown>
  ): Promise<INotification | null> {
    try {
      return await Notification.create({ recipientType, recipientId, type, title, body, data });
    } catch (err: any) {
      // Concurrent reminder sweeps race the dedupe read; the partial unique
      // index makes the second insert a no-op instead of a duplicate row.
      if (err?.code === 11000 && (type === 'event_reminder' || type === 'vote_opened' || type === 'vote_reminder')) return null;
      throw err;
    }
  }

  static async list(
    recipientType: NotificationRecipientType,
    recipientId: string,
    opts: { before?: string; limit?: number } = {}
  ): Promise<{ items: NotificationView[]; unreadCount: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const query: Record<string, unknown> = { recipientType, recipientId };
    if (opts.before) query['_id'] = { $lt: opts.before };

    const [docs, unreadCount] = await Promise.all([
      Notification.find(query).sort({ _id: -1 }).limit(limit),
      // `readAt: null` matches BOTH an absent field and an explicit null, so
      // the count agrees with the per-row `Boolean(d.readAt)` flag below and
      // with markRead — a legacy null-readAt row is unread everywhere or
      // nowhere, never a stuck in-between. ($exists:false missed null rows.)
      Notification.countDocuments({ recipientType, recipientId, readAt: null }, { limit: 99 }),
    ]);

    // Batch-hydrate the acting buyer/vendor for every row in exactly two
    // queries (never N+1), so each notification can carry the actor's avatar.
    const refs = docs.map((d) => actorRef(d.type, d.data ?? {}));
    const buyerIds = [...new Set(refs.filter((r) => r?.kind === 'buyer').map((r) => r!.id))];
    const vendorIds = [...new Set(refs.filter((r) => r?.kind === 'vendor').map((r) => r!.id))];
    const [buyers, vendors] = await Promise.all([
      buyerIds.length ? Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl') : [],
      vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl') : [],
    ]);
    const buyerById = new Map(buyers.map((b) => [String(b._id), b]));
    const vendorById = new Map(vendors.map((v) => [String(v._id), v]));

    const toActor = (ref: ActorRef | null): NotificationActor | null => {
      if (!ref) return null;
      if (ref.kind === 'buyer') {
        const b = buyerById.get(ref.id);
        if (!b) return null;
        return { type: 'buyer', id: ref.id, name: b.name ?? b.username ?? 'Someone', avatarUrl: b.avatarUrl ?? null, username: b.username ?? null };
      }
      const v = vendorById.get(ref.id);
      if (!v) return null;
      return { type: 'organizer', id: ref.id, name: v.businessName ?? 'A brand', avatarUrl: v.logoUrl ?? null, username: null };
    };

    return {
      items: docs.map((d, i) => ({
        id: String(d._id),
        type: d.type,
        title: d.title,
        body: d.body,
        data: d.data ?? {},
        read: Boolean(d.readAt),
        createdAt: d.createdAt,
        actor: toActor(refs[i] ?? null),
      })),
      unreadCount,
    };
  }

  /** ids omitted → mark ALL of the recipient's notifications read; an EMPTY ids
   *  array is a no-op (an empty selection must never wipe the inbox).
   *  Scoped to the recipient so foreign ids are silently no-ops. */
  static async markRead(recipientType: NotificationRecipientType, recipientId: string, ids?: string[]): Promise<void> {
    // `readAt: null` matches an absent field AND an explicit null, so legacy
    // rows stored with readAt:null (which list() shows as unread) can finally
    // be cleared — `{ $exists: false }` matched only absent and left them stuck.
    const query: Record<string, unknown> = { recipientType, recipientId, readAt: null };
    if (ids !== undefined) {
      if (ids.length === 0) return;
      query['_id'] = { $in: ids };
    }
    await Notification.updateMany(query, { $set: { readAt: new Date() } });
  }
}
