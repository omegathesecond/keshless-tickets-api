import { Update, IUpdate } from '@models/update.model';
import { UpdateReaction } from '@models/updateReaction.model';
import { Vendor } from '@models/vendor.model';
import { Buyer } from '@models/buyer.model';
import { updatesR2 } from '@utils/updatesR2';
import { extractHashtags } from '@utils/hashtags.util';
import { triggerTranscode } from '@services/transcode.client';
import type { UpdateAuthorType, UpdateKind } from '@interfaces/update.interface';
import { isActorAuthorOf, type SocialActor } from '@utils/socialActor.util';
import { toggleReactionGeneric } from '@services/reactions.service';
import { AccountActivityService } from '@services/accountActivity.service';

interface CreateInput {
  authorType: UpdateAuthorType;
  authorId: string;
  kind: UpdateKind;
  caption: string;
  eventId?: string;
  items: { ext: string; contentType: string }[];
}

export async function createUpdate(input: CreateInput): Promise<{ update: IUpdate; uploads: { index: number; uploadUrl: string }[] }> {
  const prepared = await Promise.all(input.items.map(async (it, index) => {
    const rawKey = updatesR2.rawKey(it.ext);
    const uploadUrl = await updatesR2.presignPut(rawKey, it.contentType);
    return { index, rawKey, uploadUrl };
  }));
  const update = await Update.create({
    authorType: input.authorType,
    authorId: input.authorId,
    kind: input.kind,
    caption: input.caption ?? '',
    hashtags: extractHashtags(input.caption),
    eventId: input.eventId,
    media: prepared.map((p) => ({ rawKey: p.rawKey, status: 'processing' })),
  });
  return { update, uploads: prepared.map((p) => ({ index: p.index, uploadUrl: p.uploadUrl })) };
}

export async function finalizeUpdate(id: string): Promise<IUpdate> {
  const update = await Update.findById(id);
  if (!update) throw new Error('Update not found');
  if (update.kind === 'image') {
    for (const item of update.media) {
      item.image = { url: updatesR2.publicUrl(item.rawKey), width: 0, height: 0 };
      item.status = 'ready';
    }
    await update.save();
    return update;
  }
  const video = update.media[0]; // videos are always a single item
  if (!video) throw new Error('Update has no media');
  video.processingStartedAt = new Date();
  video.status = 'processing';
  await update.save();
  // fire-and-forget; durability comes from reconcileStuckUpdates (Task 8)
  triggerTranscode({ id: update.id, media: update.media, collection: 'updates' }).catch((err) => console.error('triggerTranscode failed:', err?.message));
  return update;
}

export async function getUpdate(id: string): Promise<IUpdate | null> {
  return Update.findById(id);
}

/**
 * Edit a published post's caption in place — same document, same
 * createdAt/feed position, no new post created. Re-derives hashtags from the
 * new caption (create's rule, kept in sync here) and stamps editedAt so
 * every surface can show an "Edited" label. Caption length/shape validation
 * is the CALLER's job (controller), mirroring createUpdate.
 */
export async function editUpdateCaption(id: string, caption: string): Promise<IUpdate> {
  const update = await Update.findById(id);
  if (!update) throw new Error('Update not found');
  update.caption = caption;
  update.hashtags = extractHashtags(caption);
  update.editedAt = new Date();
  await update.save();
  return update;
}

const counterField = (type: 'like' | 'save') => (type === 'like' ? 'likeCount' : 'saveCount');

export async function toggleReaction(updateId: string, actor: SocialActor, type: 'like' | 'save') {
  const { active } = await toggleReactionGeneric({
    reactionModel: UpdateReaction,
    targetModel: Update,
    targetField: 'updateId',
    targetId: updateId,
    actor,
    type,
    counterField: counterField(type),
  });
  const u = await Update.findById(updateId).select('likeCount saveCount').lean();
  return { active, likeCount: u?.likeCount ?? 0, saveCount: u?.saveCount ?? 0 };
}

export async function recordShare(updateId: string) {
  const u = await Update.findByIdAndUpdate(updateId, { $inc: { shareCount: 1 } }, { new: true }).select('shareCount').lean();
  return { shareCount: u?.shareCount ?? 0 };
}

/**
 * `viewCount` increments for EVERY view including anonymous ones (the
 * public-facing counter shown on the post). `actor`, when the caller is
 * signed in, additionally records a My Account insight for the post's
 * author (spec §1) — buyer-authored posts only; organizer brands have their
 * own analytics. Self-views and repeats are filtered inside
 * AccountActivityService.record, not here.
 */
export async function recordView(updateId: string, actor?: SocialActor | null): Promise<{ viewCount: number }> {
  const u = await Update.findByIdAndUpdate(updateId, { $inc: { viewCount: 1 } }, { new: true })
    .select('viewCount authorType authorId')
    .lean();
  if (u && actor && u.authorType === 'buyer') {
    AccountActivityService.record({
      ownerId: String(u.authorId), actorType: actor.type, actorId: actor.id, kind: 'post_view', targetId: updateId,
    }).catch((err) => console.error('[account-activity] post_view record failed:', err));
  }
  return { viewCount: u?.viewCount ?? 0 };
}

export async function getViewerReactions(updateIds: string[], actor: SocialActor): Promise<Record<string, { liked: boolean; saved: boolean }>> {
  const rows = await UpdateReaction.find({ updateId: { $in: updateIds }, actorType: actor.type, buyerId: actor.id }).lean();
  const map: Record<string, { liked: boolean; saved: boolean }> = {};
  for (const id of updateIds) map[String(id)] = { liked: false, saved: false };
  for (const r of rows) {
    const k = String(r.updateId);
    if (!map[k]) map[k] = { liked: false, saved: false };
    if (r.type === 'like') map[k].liked = true;
    if (r.type === 'save') map[k].saved = true;
  }
  return map;
}

export class UpdateService {
  /** Serialize raw Update docs to feed-slide DTOs — author hydrated from
   *  Vendor/Buyer, viewerReactions defaulted to {liked:false,saved:false} and
   *  viewerIsAuthor to false when unauthenticated. Mirrors the update-slide
   *  shape feed.service.ts already produces, so callers get one definition. */
  static async buildUpdateSlides(updates: IUpdate[], actor: SocialActor | null): Promise<any[]> {
    if (updates.length === 0) return [];
    const vendorIds = updates.filter((u) => u.authorType === 'vendor').map((u) => String(u.authorId));
    const buyerIds = updates.filter((u) => u.authorType === 'buyer').map((u) => String(u.authorId));
    const vendors = vendorIds.length ? await Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl slug') : [];
    const buyers = buyerIds.length ? await Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl') : [];
    const vMap = new Map(vendors.map((v: any) => [String(v._id), v]));
    const bMap = new Map(buyers.map((b: any) => [String(b._id), b]));
    const reactions = actor ? await getViewerReactions(updates.map((u) => String(u._id)), actor) : {};

    return updates.map((u) => {
      const author = u.authorType === 'vendor'
        ? { type: 'organizer', id: String(u.authorId), name: vMap.get(String(u.authorId))?.businessName ?? 'Organizer', avatarUrl: vMap.get(String(u.authorId))?.logoUrl ?? null, slug: vMap.get(String(u.authorId))?.slug ?? null }
        : { type: 'buyer', id: String(u.authorId), name: bMap.get(String(u.authorId))?.name ?? null, username: bMap.get(String(u.authorId))?.username ?? null, avatarUrl: bMap.get(String(u.authorId))?.avatarUrl ?? null };
      return {
        type: 'update', id: String(u._id), sortAt: u.createdAt.toISOString(),
        kind: u.kind, caption: u.caption, editedAt: u.editedAt ? u.editedAt.toISOString() : null, media: u.media,
        likeCount: u.likeCount, saveCount: u.saveCount, shareCount: u.shareCount, viewCount: u.viewCount ?? 0,
        eventId: u.eventId ? String(u.eventId) : null, author,
        viewerReactions: reactions[String(u._id)] ?? { liked: false, saved: false },
        viewerIsAuthor: isActorAuthorOf(u.authorType, u.authorId, actor),
      };
    });
  }
}
