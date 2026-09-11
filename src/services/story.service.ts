import { Story, IStory } from '@models/story.model';
import { StorySeen } from '@models/storySeen.model';
import { StoryLike } from '@models/storyLike.model';
import { Follow } from '@models/follow.model';
import { Buyer } from '@models/buyer.model';
import { Vendor } from '@models/vendor.model';
import { updatesR2 } from '@utils/updatesR2';
import { triggerTranscode } from '@services/transcode.client';
import { awardStoryPointsIfEligible } from '@services/storyPoints.service';
import { BlockService } from '@services/block.service';
import { NotificationService } from '@services/notification.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { AccountActivityService } from '@services/accountActivity.service';
import { HttpError } from '@utils/httpError.util';
import { isActorAuthorOf, type SocialActor } from '@utils/socialActor.util';
import type { StoryKind } from '@interfaces/story.interface';

// Exported so ifIGo.service can stamp the same expiry on both the Story doc
// and its durable IfIGoStory sibling (see @models/ifIGoStory.model) without
// two different TTL constants drifting apart.
export const STORY_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * How long a still image is shown before the viewer auto-advances. Images
 * carry no intrinsic duration (only the transcoder measures one, and only for
 * video), so the server picks it — 5s, the WhatsApp/Instagram convention.
 * This MUST be sent as a real number: emitting null here is what made every
 * image status flash past in ~1s, because the client's
 * `Math.max(1, durationSec)` coerced null to 0 and settled on the 1s floor.
 */
const IMAGE_DURATION_SEC = 5;
/** Ceiling on a video's own duration, so one long upload can't wedge the rail. */
const MAX_DURATION_SEC = 30;
/** An 'if_i_go' card stays up longer than a plain image — there's a question
 *  and several response buttons to read, not just a photo to glance at. The
 *  client also pauses autoplay while the viewer is actively interacting with
 *  it (same affordance as a long-press pause), so this is only the default. */
const IF_I_GO_DURATION_SEC = 20;

/** Playback seconds for one story item — never null, always within [1, 30]. */
function playbackDurationSec(story: Pick<IStory, 'kind' | 'media'>): number {
  if (story.kind === 'if_i_go') return IF_I_GO_DURATION_SEC;
  if (story.kind === 'image') return IMAGE_DURATION_SEC;
  const raw = story.media?.video?.durationSec ?? IMAGE_DURATION_SEC;
  return Math.min(MAX_DURATION_SEC, Math.max(1, Math.round(raw)));
}

interface CreateStoryInput {
  actor: SocialActor;
  kind: StoryKind;
  ext: string;
  contentType: string;
}

export async function createStory(input: CreateStoryInput): Promise<{ story: IStory; uploadUrl: string }> {
  const rawKey = updatesR2.rawKey(input.ext);
  const uploadUrl = await updatesR2.presignPut(rawKey, input.contentType);
  const story = await Story.create({
    authorType: input.actor.type,
    authorId: input.actor.id,
    kind: input.kind,
    media: { rawKey, status: 'processing' },
    expiresAt: new Date(Date.now() + STORY_TTL_MS),
  });
  return { story, uploadUrl };
}

/**
 * Image finalizes to 'ready' immediately; video kicks off the async
 * transcoder and stays 'processing' until it calls back. Shared by
 * finalizeStory below (image/video kind Stories) AND
 * ifIGo.service#finalizeIfIGoStory (an 'if_i_go' Story's OPTIONAL attached
 * media) — extracted so the two never drift on how a raw upload becomes
 * ready media (DRY; this used to be inlined in finalizeStory alone).
 *
 * The transcoder microservice (transcoder/src/db.ts + transcoder/src/index.ts)
 * targets whichever collection `triggerTranscode`'s `collection` field names
 * (`'stories'` below) — Story.media is a single embedded doc (`media.*`),
 * not an array (`media.0.*`) like Update, so the transcoder branches its
 * write path on this same field. See transcode.client#Transcodable.
 */
export async function finalizeMediaOnStory(story: IStory, mediaKind: 'image' | 'video'): Promise<void> {
  if (!story.media) throw new HttpError(400, 'No media to finalize on this story');
  if (mediaKind === 'image') {
    story.media.image = { url: updatesR2.publicUrl(story.media.rawKey), width: 0, height: 0 };
    story.media.status = 'ready';
    await story.save();
    return;
  }
  story.media.processingStartedAt = new Date();
  story.media.status = 'processing';
  await story.save();
  // fire-and-forget; durability comes from reconcileStuckStories, same as
  // finalizeUpdate relies on reconcileStuckUpdates.
  triggerTranscode({ id: story.id, media: [{ rawKey: story.media.rawKey }], collection: 'stories' }).catch((err: any) => console.error('triggerTranscode (story) failed:', err?.message));
}

/** Mirrors update.service#finalizeUpdate for a plain image/video Story. */
export async function finalizeStory(id: string): Promise<IStory> {
  const story = await Story.findById(id);
  if (!story) throw new HttpError(404, 'Story not found');
  if (story.kind === 'if_i_go') {
    // 'if_i_go' Stories finalize via ifIGo.service#finalizeIfIGoStory (its
    // own publish/notify side-effects don't belong in this generic path).
    throw new HttpError(400, 'Use the If I Go finalize endpoint for this story');
  }
  await finalizeMediaOnStory(story, story.kind);
  if (story.kind === 'image' && story.authorType === 'buyer') {
    // Awaited (unlike triggerTranscode above, a real network call worth not
    // blocking on): this is one more write to the same database, and
    // awaiting it means the caller's balance is correct the moment finalize
    // resolves. A failure here must never fail the story upload itself, but
    // it must be visible, not swallowed — hence catch-and-log, not catch-and-ignore.
    try {
      await awardStoryPointsIfEligible(story.authorId, story._id);
    } catch (err: any) {
      console.error('awardStoryPointsIfEligible failed:', err?.message);
    }
  }
  // NOTE: video stories still never earn points, but now for a legitimate
  // reason (not the collection-routing bug this fixed): the transcoder
  // callback that flips media.status to 'ready' happens well after
  // finalizeStory returns, and postCount's 'ready'-only rule intentionally
  // never pays out for a still-processing (or failed) post. Award points at
  // the point media.status actually becomes 'ready' for video would need a
  // callback/webhook back into story.service — no such hook exists yet.
  return story;
}

/**
 * Author-only hard delete. Unlike Update (soft-delete via status:'removed'),
 * Story has no status field — the model already treats a story as ephemeral
 * (TTL auto-delete at expiresAt), so an early delete is just that same
 * disappearance happening on request instead of on a timer. The StorySeen
 * rows are cleaned up alongside it; they have no TTL of their own (unlike
 * Story) and would otherwise linger as orphans pointing at a gone document.
 */
export async function deleteStory(storyId: string, actor: SocialActor): Promise<void> {
  const story = await Story.findById(storyId).select('authorType authorId');
  if (!story) throw new HttpError(404, 'Story not found');
  if (!isActorAuthorOf(story.authorType, story.authorId, actor)) {
    throw new HttpError(403, 'Not your story');
  }
  await Promise.all([
    Story.deleteOne({ _id: storyId }),
    StorySeen.deleteMany({ storyId }),
    StoryLike.deleteMany({ storyId }),
  ]);
}

export async function markSeen(storyId: string, actor: SocialActor): Promise<void> {
  const story = await Story.findById(storyId).select('authorType authorId');
  if (!story) throw new HttpError(404, 'Story not found');
  // An author previewing their OWN story is not a view. Recording it would
  // list them among their own viewers, and would flip their group's `seen`
  // flag — dimming their own ring the moment they looked at it. WhatsApp
  // keeps your own status ring solid for its whole life; this is why.
  if (isActorAuthorOf(story.authorType, story.authorId, actor)) return;
  try {
    await StorySeen.create({ storyId, buyerId: actor.id, actorType: actor.type });
  } catch (err: any) {
    if (err?.code !== 11000) throw err; // already seen — idempotent
    return; // already seen — do NOT re-record the My Account insight below
  }
  // My Account insight (spec §1) — only for buyer-owned Stories; organizer
  // brands have their own analytics surface. Reached exactly once per
  // (story, viewer), same as the StorySeen row it rides on, so no throttle
  // is needed here (see AccountActivityService.THROTTLE_MS).
  if (story.authorType === 'buyer') {
    AccountActivityService.record({
      ownerId: String(story.authorId), actorType: actor.type, actorId: actor.id, kind: 'story_view', targetId: storyId,
    }).catch((err) => console.error('[account-activity] story_view record failed:', err));
  }
}

/**
 * Toggle the caller's like on one story item — create the StoryLike row if
 * absent, delete it if present. Returns the resulting state so the caller
 * (already holding the previous state client-side for the optimistic flip)
 * can reconcile against the authoritative outcome rather than guessing.
 * A liked-then-relisted story reports it back via `viewerHasLiked` in
 * listForViewer below, which is what keeps the button's state correct after
 * closing and reopening the viewer.
 */
export async function toggleLike(storyId: string, actor: SocialActor): Promise<{ liked: boolean }> {
  const story = await Story.findById(storyId).select('authorType authorId');
  if (!story) throw new HttpError(404, 'Story not found');
  const existing = await StoryLike.findOne({ storyId, actorType: actor.type, buyerId: actor.id });
  if (existing) {
    await StoryLike.deleteOne({ _id: existing._id });
    return { liked: false };
  }
  try {
    await StoryLike.create({ storyId, buyerId: actor.id, actorType: actor.type });
  } catch (err: any) {
    if (err?.code !== 11000) throw err; // raced with another like — already liked
  }
  // Best-effort: tell the author they got a like. Awaited (like
  // follow.service#notifyOrganizerFollowed) so the caller's response reflects
  // a completed attempt, but internally swallowed — a notification failure
  // must never make the like itself appear to fail.
  await notifyStoryLiked(story, storyId, actor).catch((err: any) => console.error('[story] notifyStoryLiked failed:', err?.message));
  return { liked: true };
}

/** "[Username] liked your story." — fired once per like (not on unlike, and
 *  never for liking your own story). Routes through the buyer dispatcher
 *  (prefs + block-filtering + push) when the author is a buyer, same as
 *  every other buyer-facing notification; a vendor author is written
 *  directly, mirroring follow.service#notifyOrganizerFollowed. */
async function notifyStoryLiked(
  story: Pick<IStory, 'authorType' | 'authorId'>,
  storyId: string,
  actor: SocialActor
): Promise<void> {
  if (isActorAuthorOf(story.authorType, story.authorId, actor)) return; // liking your own story
  let name = 'Someone';
  let username: string | undefined;
  if (actor.type === 'buyer') {
    const b = await Buyer.findById(actor.id).select('username name');
    name = b?.username ?? b?.name ?? 'Someone';
    username = b?.username ?? undefined;
  } else {
    const v = await Vendor.findById(actor.id).select('businessName');
    name = v?.businessName ?? 'A brand';
  }
  const body = `${name} liked your story.`;
  const data = { storyId, actorId: actor.id, actorType: actor.type, ...(username ? { username } : {}) };
  if (story.authorType === 'vendor') {
    await NotificationService.create('vendor', String(story.authorId), 'story_like', 'New like', body, data).catch(() => undefined);
  } else {
    // Awaited (unlike message.service's DM fan-out, which is fire-and-forget
    // for latency): a like is a single-recipient write, cheap enough that the
    // caller can wait for prefs/block-filtering/push to actually complete.
    await NotificationDispatcher.dispatch([String(story.authorId)], 'story_like', 'New like', body, data, actor.id);
  }
}

export interface StoryViewerDto {
  type: 'buyer' | 'organizer';
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  seenAt: Date;
}

/**
 * Who has seen one story, most recent first — the WhatsApp "viewed by" list.
 * AUTHOR-ONLY: viewers of someone else's story are private, so a non-author
 * gets 403 rather than an empty list (an empty list would read as "nobody
 * watched", which is a different and misleading claim).
 *
 * Self-views are never stored (see markSeen), so the author cannot appear here.
 */
export async function listViewers(storyId: string, actor: SocialActor): Promise<StoryViewerDto[]> {
  const story = await Story.findById(storyId).select('authorType authorId');
  if (!story) throw new HttpError(404, 'Story not found');
  if (!isActorAuthorOf(story.authorType, story.authorId, actor)) {
    throw new HttpError(403, 'Not your story');
  }

  const rows = await StorySeen.find({ storyId }).sort({ createdAt: -1 });
  if (rows.length === 0) return [];

  const buyerIds = rows.filter((r) => r.actorType === 'buyer').map((r) => String(r.buyerId));
  const vendorIds = rows.filter((r) => r.actorType === 'vendor').map((r) => String(r.buyerId));
  const [buyers, vendors] = await Promise.all([
    buyerIds.length ? Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl') : [],
    vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl') : [],
  ]);
  const bMap = new Map(buyers.map((b: any) => [String(b._id), b]));
  const vMap = new Map(vendors.map((v: any) => [String(v._id), v]));

  return rows.map((r) => {
    const id = String(r.buyerId);
    if (r.actorType === 'vendor') {
      const v = vMap.get(id);
      return {
        type: 'organizer' as const,
        id,
        name: v?.businessName ?? 'Organizer',
        username: null,
        avatarUrl: v?.logoUrl ?? null,
        seenAt: r.createdAt,
      };
    }
    const b = bMap.get(id);
    return {
      type: 'buyer' as const,
      id,
      name: b?.name ?? null,
      username: b?.username ?? null,
      avatarUrl: b?.avatarUrl ?? null,
      seenAt: r.createdAt,
    };
  });
}

export interface StoryLikerDto {
  type: 'buyer' | 'organizer';
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  likedAt: Date;
}

/**
 * Who has liked one story, most recent first. AUTHOR-ONLY, same shape and
 * privacy rule as listViewers above: a non-author gets 403 rather than an
 * empty list, so "nobody has liked yet" and "you can't see this" never look
 * the same.
 */
export async function listLikers(storyId: string, actor: SocialActor): Promise<StoryLikerDto[]> {
  const story = await Story.findById(storyId).select('authorType authorId');
  if (!story) throw new HttpError(404, 'Story not found');
  if (!isActorAuthorOf(story.authorType, story.authorId, actor)) {
    throw new HttpError(403, 'Not your story');
  }

  const rows = await StoryLike.find({ storyId }).sort({ createdAt: -1 });
  if (rows.length === 0) return [];

  const buyerIds = rows.filter((r) => r.actorType === 'buyer').map((r) => String(r.buyerId));
  const vendorIds = rows.filter((r) => r.actorType === 'vendor').map((r) => String(r.buyerId));
  const [buyers, vendors] = await Promise.all([
    buyerIds.length ? Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl') : [],
    vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl') : [],
  ]);
  const bMap = new Map(buyers.map((b: any) => [String(b._id), b]));
  const vMap = new Map(vendors.map((v: any) => [String(v._id), v]));

  return rows.map((r) => {
    const id = String(r.buyerId);
    if (r.actorType === 'vendor') {
      const v = vMap.get(id);
      return {
        type: 'organizer' as const,
        id,
        name: v?.businessName ?? 'Organizer',
        username: null,
        avatarUrl: v?.logoUrl ?? null,
        likedAt: r.createdAt,
      };
    }
    const b = bMap.get(id);
    return {
      type: 'buyer' as const,
      id,
      name: b?.name ?? null,
      username: b?.username ?? null,
      avatarUrl: b?.avatarUrl ?? null,
      likedAt: r.createdAt,
    };
  });
}

export interface StoryItemDto {
  id: string;
  mediaUrl: string;
  kind: StoryKind;
  durationSec: number;
  createdAt: Date;
  /** 'if_i_go' only — optional caption under the question (spec §1.2). */
  caption?: string;
  /** 'if_i_go' only, and only when no media was attached — the flat brand
   *  backdrop (see story.model.IF_I_GO_BACKGROUND_PRESETS). */
  background?: { preset: string };
  /** How many others have seen this item. Only populated on the viewer's OWN
   *  items — view counts on other people's stories are private. */
  viewerCount?: number;
  /** How many people have liked this item. Only populated on the viewer's OWN
   *  items, same privacy scoping as viewerCount — displayed next to "Seen N"
   *  as "Likes N" (spec: Story Likes and Notifications Update). */
  likeCount?: number;
  /** Whether the viewer has liked this item — round-tripped so the Like
   *  button in the story viewer opens already in the right state instead of
   *  resetting every time the story is closed and reopened. */
  viewerHasLiked: boolean;
  /** 'processing' | 'ready' | 'failed'. Only ever non-'ready' on the viewer's
   *  OWN items — see listForViewer's query for why other authors' non-ready
   *  media never reaches this DTO at all. Lets the client show "processing
   *  your video…" / a failure state on your own pending story instead of it
   *  just silently not appearing (or, for a failed one, silently vanishing
   *  at the 48h TTL with no explanation). */
  mediaStatus: 'processing' | 'ready' | 'failed';
}

export interface StoryGroupDto {
  // `username` is only ever set for a buyer author (an organizer's profile
  // route uses vendorId, not a handle — see StoryViewer's authorHref) but
  // lives on the shared shape like the other author DTOs above (StoryViewerDto,
  // StoryLikerDto) so the client can build a profile link straight off the
  // author it already has, without a second round-trip.
  author: { type: 'buyer' | 'organizer'; id: string; name: string | null; username: string | null; avatarUrl: string | null };
  items: StoryItemDto[];
  seen: boolean;
  isOwn: boolean;
}

/**
 * Active (unexpired, media-ready) stories from EVERYONE on Carrot — not just
 * authors the viewer follows. Explicit client decision: follower-only
 * visibility discouraged posting while the user base is still small, so
 * Stories are global, same as the "for-you" Discover feed (see
 * feed.service#getFeed). Still excludes authors blocked in EITHER direction
 * (mirrors nearby.service#nearbyPeople) — global visibility should not
 * resurrect content from someone you've blocked or who has blocked you.
 * Own stories are never excluded (you can't block yourself).
 *
 * Grouped by author. Ordering: own group first, then groups with any unseen
 * item, then fully-seen groups; within each bucket, most-recently-posted
 * author first.
 */
export async function listForViewer(actor: SocialActor): Promise<StoryGroupDto[]> {
  const [iBlocked, blockedMe] = await Promise.all([
    BlockService.listBlockedIds(actor.id),
    BlockService.listBlockerIds(actor.id),
  ]);
  const excludedAuthorIds = [...new Set([...iBlocked, ...blockedMe])];

  // NOT filtered to 'media.status':'ready' here — a viewer's OWN
  // processing/failed story must still come back so its author can see it
  // (rather than it silently never appearing, or vanishing unexplained at
  // the 48h TTL). Other authors' non-ready items are dropped per-item below
  // instead, once isOwnStory is known.
  const stories = await Story.find({
    expiresAt: { $gt: new Date() },
    authorId: { $nin: excludedAuthorIds },
  }).sort({ createdAt: 1 }); // ascending: items build up chronologically per author below

  if (stories.length === 0) return [];

  const vendorIds = [...new Set(stories.filter((s) => s.authorType === 'vendor').map((s) => String(s.authorId)))];
  const buyerIds = [...new Set(stories.filter((s) => s.authorType === 'buyer').map((s) => String(s.authorId)))];
  const [vendors, buyers, seenRows, likedRows] = await Promise.all([
    vendorIds.length ? Vendor.find({ _id: { $in: vendorIds } }).select('businessName logoUrl') : [],
    buyerIds.length ? Buyer.find({ _id: { $in: buyerIds } }).select('name username avatarUrl') : [],
    StorySeen.find({ actorType: actor.type, buyerId: actor.id, storyId: { $in: stories.map((s) => s._id) } }).select('storyId'),
    StoryLike.find({ actorType: actor.type, buyerId: actor.id, storyId: { $in: stories.map((s) => s._id) } }).select('storyId'),
  ]);
  const vMap = new Map(vendors.map((v: any) => [String(v._id), v]));
  const bMap = new Map(buyers.map((b: any) => [String(b._id), b]));
  const seenSet = new Set(seenRows.map((r: any) => String(r.storyId)));
  const likedSet = new Set(likedRows.map((r: any) => String(r.storyId)));

  // Who among this batch's 'followers'-scoped authors the viewer actually
  // follows — scoped to just those authors, not a full following list.
  // Keyed `${targetType}:${targetId}` since an author can be a buyer OR an
  // organizer brand and Follow.targetType distinguishes the two.
  const followersScopedAuthors = stories.filter((s) => s.audience === 'followers');
  const followingAuthorIds = new Set<string>();
  if (followersScopedAuthors.length) {
    const byTargetType = new Map<'buyer' | 'organizer', Set<string>>();
    for (const s of followersScopedAuthors) {
      const targetType = s.authorType === 'vendor' ? 'organizer' : 'buyer';
      if (!byTargetType.has(targetType)) byTargetType.set(targetType, new Set());
      byTargetType.get(targetType)!.add(String(s.authorId));
    }
    const followRows = await Follow.find({
      followerType: actor.type,
      followerId: actor.id,
      $or: [...byTargetType.entries()].map(([targetType, ids]) => ({ targetType, targetId: { $in: [...ids] } })),
    }).select('targetId');
    for (const r of followRows) followingAuthorIds.add(String(r.targetId));
  }

  // "Seen by N" / "Liked by N" for the viewer's OWN items, so the rail/viewer
  // can label both counts without extra round-trips. Scoped to own stories
  // only — seen/like counts on other people's stories are the author's
  // business, not yours.
  const ownStoryIds = stories.filter((s) => isActorAuthorOf(s.authorType, s.authorId, actor)).map((s) => s._id);
  const viewerCounts = new Map<string, number>();
  const likeCounts = new Map<string, number>();
  if (ownStoryIds.length) {
    const [seenCounts, likeCountRows] = await Promise.all([
      StorySeen.aggregate<{ _id: any; n: number }>([
        { $match: { storyId: { $in: ownStoryIds } } },
        { $group: { _id: '$storyId', n: { $sum: 1 } } },
      ]),
      StoryLike.aggregate<{ _id: any; n: number }>([
        { $match: { storyId: { $in: ownStoryIds } } },
        { $group: { _id: '$storyId', n: { $sum: 1 } } },
      ]),
    ]);
    for (const c of seenCounts) viewerCounts.set(String(c._id), c.n);
    for (const c of likeCountRows) likeCounts.set(String(c._id), c.n);
  }

  const groups = new Map<string, StoryGroupDto & { latestCreatedAt: number }>();
  for (const s of stories) {
    const isOwnStory = isActorAuthorOf(s.authorType, s.authorId, actor);
    // Someone else's still-processing/failed upload is theirs to see, not
    // the viewer's — only the author gets a non-'ready' item (see the query
    // comment above and StoryItemDto.mediaStatus). A medialess 'if_i_go'
    // card (background-only) has no media doc at all and is always ready.
    const mediaReady = !s.media || s.media.status === 'ready';
    if (!isOwnStory && !mediaReady) continue;
    // 'if_i_go' audience narrowing (spec §1.4): a story explicitly scoped to
    // 'followers' is invisible to everyone else, own-story exempted like
    // every other gate here.
    if (!isOwnStory && s.audience === 'followers' && !followingAuthorIds.has(String(s.authorId))) continue;
    const key = `${s.authorType}:${String(s.authorId)}`;
    let group = groups.get(key);
    if (!group) {
      const isOwn = isOwnStory;
      const author = s.authorType === 'vendor'
        ? { type: 'organizer' as const, id: String(s.authorId), name: vMap.get(String(s.authorId))?.businessName ?? 'Organizer', username: null, avatarUrl: vMap.get(String(s.authorId))?.logoUrl ?? null }
        : { type: 'buyer' as const, id: String(s.authorId), name: bMap.get(String(s.authorId))?.name ?? bMap.get(String(s.authorId))?.username ?? null, username: bMap.get(String(s.authorId))?.username ?? null, avatarUrl: bMap.get(String(s.authorId))?.avatarUrl ?? null };
      group = { author, items: [], seen: true, isOwn, latestCreatedAt: 0 };
      groups.set(key, group);
    }
    const visualKind = s.kind === 'if_i_go' ? (s.media?.video ? 'video' : s.media?.image ? 'image' : null) : s.kind;
    const mediaUrl = visualKind === 'video' ? s.media?.video?.url ?? '' : visualKind === 'image' ? s.media?.image?.url ?? '' : '';
    group.items.push({
      id: s.id,
      mediaUrl,
      kind: s.kind,
      durationSec: playbackDurationSec(s),
      createdAt: s.createdAt,
      viewerHasLiked: likedSet.has(String(s._id)),
      mediaStatus: s.media?.status ?? 'ready',
      ...(s.caption ? { caption: s.caption } : {}),
      ...(s.background ? { background: s.background } : {}),
      ...(isOwnStory ? { viewerCount: viewerCounts.get(String(s._id)) ?? 0, likeCount: likeCounts.get(String(s._id)) ?? 0 } : {}),
    });
    group.latestCreatedAt = s.createdAt.getTime();
    if (!seenSet.has(String(s._id))) group.seen = false;
  }

  const all = Array.from(groups.values()).sort((a, b) => b.latestCreatedAt - a.latestCreatedAt);
  const own = all.filter((g) => g.isOwn);
  const unseen = all.filter((g) => !g.isOwn && !g.seen);
  const seen = all.filter((g) => !g.isOwn && g.seen);
  return [...own, ...unseen, ...seen].map(({ latestCreatedAt, ...g }) => g);
}
