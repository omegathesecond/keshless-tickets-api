import { Types } from 'mongoose';
import { Story, IStory, IF_I_GO_BACKGROUND_PRESETS, IfIGoBackgroundPreset } from '@models/story.model';
import { StorySeen } from '@models/storySeen.model';
import { StoryLike } from '@models/storyLike.model';
import { IfIGoStory, IIfIGoStory } from '@models/ifIGoStory.model';
import { IfIGoResponse } from '@models/ifIGoResponse.model';
import { Notification } from '@models/notification.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { Event } from '@models/event.model';
import { EventPlan } from '@models/eventPlan.model';
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { Follow } from '@models/follow.model';
import { BlockService } from '@services/block.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { DmThreadService } from '@services/dmThread.service';
import { MessageService } from '@services/message.service';
import { finalizeMediaOnStory, STORY_TTL_MS } from '@services/story.service';
import { updatesR2 } from '@utils/updatesR2';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';
import {
  SUGGESTED_IF_I_GO_OPTIONS,
  SUGGESTED_IF_I_GO_OPTION_KEYS,
  IF_I_GO_MIN_OPTIONS,
  IF_I_GO_MAX_OPTIONS,
  IF_I_GO_OPTION_LABEL_MAXLEN,
  IF_I_GO_PRIVATE_MESSAGE_MAXLEN,
  IfIGoAudience,
  IfIGoOptionDef,
  IfIGoResponseStatus,
} from '@interfaces/ifIGo.interface';

const displayName = (b: IBuyer | null | undefined): string => b?.username ?? b?.name ?? 'Someone';

const slugifyCustomOption = (label: string): string => {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'option';
  return `custom:${slug}`;
};

/** Turn the creator's raw option picks (suggested keys + custom labels) into
 *  a frozen, ordered, de-duplicated option list (spec §2). Two custom
 *  options that slugify to the same key get a numeric suffix rather than
 *  silently merging — the creator asked for two distinct buttons. */
function normalizeOptions(raw: Array<{ key?: string; label?: string }>): IfIGoOptionDef[] {
  if (!Array.isArray(raw) || raw.length < IF_I_GO_MIN_OPTIONS || raw.length > IF_I_GO_MAX_OPTIONS) {
    throw new HttpError(400, `Choose between ${IF_I_GO_MIN_OPTIONS} and ${IF_I_GO_MAX_OPTIONS} response options`);
  }
  const seen = new Set<string>();
  const out: IfIGoOptionDef[] = [];
  raw.forEach((o, i) => {
    let key: string;
    let label: string;
    if (o.key && SUGGESTED_IF_I_GO_OPTION_KEYS.has(o.key)) {
      key = o.key;
      label = SUGGESTED_IF_I_GO_OPTIONS.find((s) => s.key === key)!.label;
    } else {
      const rawLabel = (o.label || '').trim();
      if (!rawLabel) throw new HttpError(400, 'Every response option needs a label');
      if (rawLabel.length > IF_I_GO_OPTION_LABEL_MAXLEN) {
        throw new HttpError(400, `Response options must be ${IF_I_GO_OPTION_LABEL_MAXLEN} characters or fewer`);
      }
      label = rawLabel;
      key = slugifyCustomOption(rawLabel);
    }
    let uniqueKey = key;
    let suffix = 2;
    while (seen.has(uniqueKey)) uniqueKey = `${key}_${suffix++}`;
    seen.add(uniqueKey);
    out.push({ key: uniqueKey, label, order: i });
  });
  return out;
}

/** Default private status a fresh selection starts at (spec §7) — depends on
 *  what kind of ask the option represents, not on who picked it. */
function initialStatusFor(optionKey: string): IfIGoResponseStatus {
  if (optionKey === 'buy_ticket' || optionKey === 'buy_drink') return 'offered';
  if (optionKey === 'join_table' || optionKey === 'ask_join_table') return 'request_sent';
  return 'interested';
}

/** Contextual label for a (option, status) pair — the generic status enum
 *  reads naturally once paired with what it's a status OF (spec §7/§8/§9). */
function statusLabel(optionKey: string, status: IfIGoResponseStatus): string {
  if (status === 'completed') {
    if (optionKey === 'buy_ticket') return 'Ticket purchased';
    if (optionKey === 'buy_drink') return 'Drink purchased';
    return 'Completed';
  }
  if (status === 'accepted') return 'Accepted';
  if (status === 'declined') return 'Declined';
  if (status === 'request_sent') return optionKey === 'ask_join_table' ? 'Invitation sent' : 'Request sent';
  if (status === 'offered') return 'Offer sent';
  return 'Interested';
}

interface EventSummary {
  id: string;
  name: string;
  venue: string;
  eventDate: Date;
  posterUrl: string | null;
}

async function loadEventSummary(eventId: Types.ObjectId | string): Promise<EventSummary> {
  const event = await Event.findById(eventId).select('name venue eventDate posterUrl');
  if (!event) throw new HttpError(404, 'Event not found');
  return { id: String(event._id), name: event.name, venue: event.venue, eventDate: event.eventDate, posterUrl: event.posterUrl ?? null };
}

interface CreatorSummary { id: string; name: string | null; username: string | null; avatarUrl: string | null }

function toCreatorSummary(b: IBuyer | null): CreatorSummary {
  return { id: b ? String(b._id) : '', name: b?.name ?? null, username: b?.username ?? null, avatarUrl: b?.avatarUrl ?? null };
}

export interface IfIGoOptionResultDto { key: string; label: string; count: number; percentage: number }

export interface IfIGoSelectionDto { optionKey: string; label: string; status: IfIGoResponseStatus; statusLabel: string }

export interface IfIGoPublicDto {
  id: string;
  storyId: string;
  event: EventSummary;
  creator: CreatorSummary;
  question: string;
  options: IfIGoOptionDef[];
  allowMultiple: boolean;
  responsesEnabled: boolean;
  audience: IfIGoAudience;
  expired: boolean;
  isOwn: boolean;
  results: IfIGoOptionResultDto[];
  totalParticipants: number;
  viewerSelections: IfIGoSelectionDto[];
  viewerPrivateMessage: string | null;
}

export type IfIGoAvailability = { available: false; reason: 'not_found' | 'expired' } | { available: true; poll: IfIGoPublicDto };

async function computeResults(ifIGoStoryId: Types.ObjectId, options: IfIGoOptionDef[]): Promise<{ results: IfIGoOptionResultDto[]; totalParticipants: number }> {
  const [counts, totalParticipants] = await Promise.all([
    IfIGoResponse.aggregate<{ _id: string; n: number }>([
      { $match: { ifIGoStoryId } },
      { $unwind: '$selections' },
      { $group: { _id: '$selections.optionKey', n: { $sum: 1 } } },
    ]),
    IfIGoResponse.countDocuments({ ifIGoStoryId }),
  ]);
  const countMap = new Map(counts.map((c) => [c._id, c.n]));
  const results = options
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((o) => {
      const count = countMap.get(o.key) ?? 0;
      const percentage = totalParticipants > 0 ? Math.round((count / totalParticipants) * 1000) / 10 : 0;
      return { key: o.key, label: o.label, count, percentage };
    });
  return { results, totalParticipants };
}

/**
 * The Story+IfIGoStory→DTO assembly shared by getIfIGoStory (fresh load) and
 * every mutation below that returns the poll's new state inline (respond,
 * removeResponse, toggleResponses, updateResponseStatus) — so a client never
 * needs a second round trip just to see the effect of its own write.
 */
async function toPublicDto(
  poll: IIfIGoStory,
  event: EventSummary,
  creator: IBuyer | null,
  viewer: IBuyer | null,
  expired: boolean
): Promise<IfIGoPublicDto> {
  const { results, totalParticipants } = await computeResults(poll._id, poll.options);
  let viewerSelections: IfIGoSelectionDto[] = [];
  let viewerPrivateMessage: string | null = null;
  if (viewer) {
    const own = await IfIGoResponse.findOne({ ifIGoStoryId: poll._id, respondentId: viewer._id });
    if (own) {
      viewerSelections = own.selections.map((s) => ({ optionKey: s.optionKey, label: poll.options.find((o) => o.key === s.optionKey)?.label ?? s.optionKey, status: s.status, statusLabel: statusLabel(s.optionKey, s.status) }));
      viewerPrivateMessage = own.privateMessage ?? null;
    }
  }
  return {
    id: String(poll._id),
    storyId: String(poll.storyId),
    event,
    creator: toCreatorSummary(creator),
    question: poll.question,
    options: poll.options.slice().sort((a, b) => a.order - b.order),
    allowMultiple: poll.allowMultiple,
    responsesEnabled: poll.responsesEnabled,
    audience: poll.audience,
    expired,
    isOwn: Boolean(viewer && String(viewer._id) === String(poll.creatorId)),
    results,
    totalParticipants,
    viewerSelections,
    viewerPrivateMessage,
  };
}

export interface CreateIfIGoInput {
  eventId: string;
  options: Array<{ key?: string; label?: string }>;
  allowMultiple?: boolean;
  audience?: IfIGoAudience;
  caption?: string;
  background?: { preset: string };
  media?: { kind: 'image' | 'video'; ext: string; contentType: string };
}

const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export interface CreateIfIGoResult {
  storyId: string;
  ifIGoStoryId: string;
  uploadUrl: string | null;
  published: boolean;
}

/**
 * Step 1 of creating an If I Go… Story (spec §1): pick an upcoming event,
 * choose responses, set audience, optionally attach media. If media was
 * requested the caller must upload to `uploadUrl` then call
 * finalizeIfIGoStory — mirrors story.service#createStory/finalizeStory's
 * two-step shape exactly. With no media the card is immediately ready and
 * gets published (follower notifications fire) right here.
 */
export async function createIfIGoStory(buyer: IBuyer, input: CreateIfIGoInput): Promise<CreateIfIGoResult> {
  const event = await Event.findById(input.eventId).select('name eventDate');
  if (!event) throw new HttpError(404, 'Event not found');
  if (event.eventDate.getTime() <= Date.now()) {
    throw new HttpError(400, 'You can only create an If I Go… poll for an upcoming event');
  }

  const options = normalizeOptions(input.options);
  const allowMultiple = input.allowMultiple !== false;
  const audience: IfIGoAudience = input.audience === 'followers' ? 'followers' : 'everyone';
  const caption = input.caption?.trim().slice(0, 200) || undefined;

  let backgroundPreset: IfIGoBackgroundPreset | undefined;
  if (!input.media && input.background?.preset && (IF_I_GO_BACKGROUND_PRESETS as readonly string[]).includes(input.background.preset)) {
    backgroundPreset = input.background.preset as IfIGoBackgroundPreset;
  } else if (!input.media) {
    backgroundPreset = 'carrot_gradient'; // sensible default so a medialess card is never blank
  }

  let mediaField: IStory['media'];
  let uploadUrl: string | null = null;
  if (input.media) {
    const allow = input.media.kind === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
    if (!allow.includes(input.media.contentType)) throw new HttpError(400, `Invalid contentType for ${input.media.kind}`);
    const rawKey = updatesR2.rawKey(input.media.ext || 'bin');
    uploadUrl = await updatesR2.presignPut(rawKey, input.media.contentType);
    mediaField = { rawKey, status: 'processing' } as IStory['media'];
  }

  const expiresAt = new Date(Date.now() + STORY_TTL_MS);
  const story = await Story.create({
    authorType: 'buyer',
    authorId: buyer._id,
    kind: 'if_i_go',
    media: mediaField,
    mediaKind: input.media?.kind,
    audience,
    caption,
    background: backgroundPreset ? { preset: backgroundPreset } : undefined,
    expiresAt,
  });

  const question = `If I go to ${event.name}, will you…?`;
  const poll = await IfIGoStory.create({
    storyId: story._id,
    eventId: event._id,
    creatorId: buyer._id,
    question,
    options,
    allowMultiple,
    audience,
    responsesEnabled: true,
    expiresAt,
  });

  let published = false;
  if (!input.media) {
    await notifyFollowersOfPublish(story, poll, buyer);
    published = true;
  }

  return { storyId: story.id, ifIGoStoryId: poll.id, uploadUrl, published };
}

/** Step 2 (only when media was attached) — finalizes the upload then
 *  publishes exactly like the medialess path above. */
export async function finalizeIfIGoStory(storyId: string, buyer: IBuyer): Promise<IfIGoAvailability> {
  const story = await Story.findById(storyId);
  if (!story || story.kind !== 'if_i_go') throw new HttpError(404, 'If I Go… story not found');
  if (String(story.authorId) !== String(buyer._id)) throw new HttpError(403, 'Not your story');
  const poll = await IfIGoStory.findOne({ storyId: story._id });
  if (!poll) throw new HttpError(404, 'If I Go… poll not found');

  if (story.media && story.mediaKind) {
    await finalizeMediaOnStory(story, story.mediaKind);
  }
  await notifyFollowersOfPublish(story, poll, buyer);
  return getIfIGoStory(storyId, buyer);
}

/** Notify the creator's followers exactly once per Story (spec §4) — guarded
 *  by an existence check (handles finalize being retried) AND the DB's
 *  partial unique index (defense-in-depth against a concurrent retry racing
 *  past the check — see notification.model.ts's if_i_go_posted_dedupe). */
async function notifyFollowersOfPublish(story: IStory, poll: IIfIGoStory, creator: IBuyer): Promise<void> {
  const already = await Notification.exists({ type: 'if_i_go_posted', 'data.storyId': String(story._id) });
  if (already) return;

  const followRows = await Follow.find({ followerType: 'buyer', targetType: 'buyer', targetId: creator._id }).select('followerId');
  const recipientIds = followRows.map((r) => String(r.followerId));
  if (recipientIds.length === 0) return;

  const event = await Event.findById(poll.eventId).select('name');
  const name = displayName(creator);
  await NotificationDispatcher.dispatch(
    recipientIds,
    'if_i_go_posted',
    name,
    `posted an If I Go… poll for ${event?.name ?? 'an event'}. See what people are willing to do.`,
    { storyId: String(story._id), ifIGoStoryId: String(poll._id), eventId: String(poll.eventId), actorId: String(creator._id) },
    String(creator._id)
  ).catch((err) => console.error('[if-i-go] publish notification failed:', err));
}

/**
 * The story + its poll + results, gated by the same visibility rule as
 * viewing the Story itself (spec §6 "everyone permitted to view the Story"):
 * blocked-either-way excluded, 'followers' audience requires actually
 * following the creator, own poll always visible. AFTER expiry (or once the
 * underlying Story has TTL'd away — see @models/ifIGoStory.model's doc
 * comment on why this collection outlives it), only the CREATOR may still
 * read it (spec §14 "archived results visible only to the Story creator").
 */
export async function getIfIGoStory(storyId: string, viewer: IBuyer | null): Promise<IfIGoAvailability> {
  if (!HEX24.test(storyId)) return { available: false, reason: 'not_found' };
  const poll = await IfIGoStory.findOne({ storyId });
  if (!poll) return { available: false, reason: 'not_found' };

  const story = await Story.findById(storyId);
  const event = await loadEventSummary(poll.eventId);
  const isOwn = Boolean(viewer && String(viewer._id) === String(poll.creatorId));
  const expired = !story || poll.expiresAt.getTime() <= Date.now() || event.eventDate.getTime() <= Date.now();

  if (expired) {
    if (!isOwn) return { available: false, reason: 'expired' };
  } else {
    if (!isOwn) {
      if (viewer && (await BlockService.isBlockedEitherWay(String(viewer._id), String(poll.creatorId)))) {
        return { available: false, reason: 'not_found' };
      }
      if (poll.audience === 'followers') {
        if (!viewer) return { available: false, reason: 'not_found' };
        const follows = await Follow.exists({ followerType: 'buyer', followerId: viewer._id, targetType: 'buyer', targetId: poll.creatorId });
        if (!follows) return { available: false, reason: 'not_found' };
      }
    }
  }

  const creator = await Buyer.findById(poll.creatorId).select('name username avatarUrl');
  const dto = await toPublicDto(poll, event, creator, viewer, expired);
  return { available: true, poll: dto };
}

export interface RespondInput { optionKeys: string[]; privateMessage?: string }

/**
 * Select (or change) a response — an upsert exactly like VoteResponse (see
 * that model's doc comment): a repeated tap or a switched selection can
 * never create a second row, and this is the ONLY write path, so "change
 * your response while active" (spec §5) needs no separate endpoint.
 */
export async function respondToIfIGoStory(buyer: IBuyer, storyId: string, input: RespondInput): Promise<IfIGoAvailability> {
  const poll = await IfIGoStory.findOne({ storyId });
  if (!poll) throw new HttpError(404, 'If I Go… poll not found');
  if (!poll.responsesEnabled) throw new HttpError(403, 'The creator has disabled further responses');

  const event = await Event.findById(poll.eventId).select('name eventDate');
  if (!event) throw new HttpError(404, 'Event not found');
  if (poll.expiresAt.getTime() <= Date.now() || event.eventDate.getTime() <= Date.now()) {
    throw new HttpError(403, 'This poll is no longer accepting responses');
  }
  if (await BlockService.isBlockedEitherWay(String(buyer._id), String(poll.creatorId))) {
    throw new HttpError(403, 'You cannot respond to this poll');
  }
  if (poll.audience === 'followers') {
    const follows = await Follow.exists({ followerType: 'buyer', followerId: buyer._id, targetType: 'buyer', targetId: poll.creatorId });
    if (!follows && String(buyer._id) !== String(poll.creatorId)) throw new HttpError(403, 'Only followers may respond to this poll');
  }

  const validKeys = new Set(poll.options.map((o) => o.key));
  const keys = [...new Set(input.optionKeys)].filter((k) => validKeys.has(k));
  if (keys.length === 0) throw new HttpError(400, 'Select at least one response');
  if (!poll.allowMultiple && keys.length > 1) throw new HttpError(400, 'This poll only accepts one response per person');
  const privateMessage = input.privateMessage?.trim().slice(0, IF_I_GO_PRIVATE_MESSAGE_MAXLEN) || undefined;

  const existing = await IfIGoResponse.findOne({ ifIGoStoryId: poll._id, respondentId: buyer._id });
  const existingStatusByKey = new Map((existing?.selections ?? []).map((s) => [s.optionKey, s.status]));
  const selections = keys.map((key) => ({
    optionKey: key,
    // Preserve an in-flight status (e.g. already 'accepted') if the
    // respondent re-selects the same option; only a genuinely NEW selection
    // starts at its initial status.
    status: existingStatusByKey.get(key) ?? initialStatusFor(key),
    statusChangedAt: existingStatusByKey.has(key) ? (existing!.selections.find((s) => s.optionKey === key)!.statusChangedAt) : new Date(),
  }));

  await IfIGoResponse.findOneAndUpdate(
    { ifIGoStoryId: poll._id, respondentId: buyer._id },
    { $set: { storyId: poll.storyId, eventId: poll.eventId, selections, privateMessage } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  await notifyCreatorOfResponse(poll, buyer, keys, privateMessage);
  return getIfIGoStory(storyId, buyer);
}

async function notifyCreatorOfResponse(poll: IIfIGoStory, respondent: IBuyer, keys: string[], privateMessage?: string): Promise<void> {
  if (String(respondent._id) === String(poll.creatorId)) return; // responding to your own poll
  const event = await Event.findById(poll.eventId).select('name');
  const labels = keys.map((k) => poll.options.find((o) => o.key === k)?.label ?? k);
  const wants = labels.length === 1 ? `wants to ${labels[0]!.toLowerCase()}` : `is willing to: ${labels.join(', ').toLowerCase()}`;
  const body = `${wants} for ${event?.name ?? 'your event'}${privateMessage ? ' and sent you a message' : ''}.`;
  NotificationDispatcher.dispatchAsync(
    [String(poll.creatorId)],
    'if_i_go_response',
    displayName(respondent),
    body,
    { storyId: String(poll.storyId), ifIGoStoryId: String(poll._id), respondentId: String(respondent._id), optionKeys: keys },
    String(respondent._id)
  );
}

/** Remove your own response entirely while the poll is still active (spec §5). */
export async function removeIfIGoResponse(buyer: IBuyer, storyId: string): Promise<void> {
  const poll = await IfIGoStory.findOne({ storyId });
  if (!poll) throw new HttpError(404, 'If I Go… poll not found');
  await IfIGoResponse.deleteOne({ ifIGoStoryId: poll._id, respondentId: buyer._id });
}

/** Creator-only toggle — spec §12 "disable further responses" without
 *  deleting the Story or its already-collected results. */
export async function toggleResponses(creator: IBuyer, storyId: string, enabled: boolean): Promise<void> {
  const poll = await IfIGoStory.findOne({ storyId });
  if (!poll) throw new HttpError(404, 'If I Go… poll not found');
  if (String(poll.creatorId) !== String(creator._id)) throw new HttpError(403, 'Not your poll');
  poll.responsesEnabled = enabled;
  await poll.save();
}

/** Author-only hard delete, mirroring story.service#deleteStory but also
 *  cleaning up this feature's own rows (the base Story delete has no idea
 *  IfIGoStory/IfIGoResponse exist). */
export async function deleteIfIGoStory(creator: IBuyer, storyId: string): Promise<void> {
  const story = await Story.findById(storyId).select('authorId kind');
  if (!story || story.kind !== 'if_i_go') throw new HttpError(404, 'Story not found');
  if (String(story.authorId) !== String(creator._id)) throw new HttpError(403, 'Not your story');
  const poll = await IfIGoStory.findOne({ storyId });
  await Promise.all([
    Story.deleteOne({ _id: storyId }),
    StorySeen.deleteMany({ storyId }),
    StoryLike.deleteMany({ storyId }),
    poll ? IfIGoResponse.deleteMany({ ifIGoStoryId: poll._id }) : Promise.resolve(),
    poll ? IfIGoStory.deleteOne({ _id: poll._id }) : Promise.resolve(),
  ]);
}

export interface RespondentDto {
  id: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  selections: IfIGoSelectionDto[];
  privateMessage: string | null;
  respondedAt: Date;
}

/**
 * Creator-only — "who responded, what they picked, their message, when, and
 * whether the related action completed" (spec §5). Never exposed to anyone
 * but the creator; public results (getIfIGoStory) never carry this.
 */
export async function listRespondents(creator: IBuyer, storyId: string): Promise<RespondentDto[]> {
  const poll = await IfIGoStory.findOne({ storyId });
  if (!poll) throw new HttpError(404, 'If I Go… poll not found');
  if (String(poll.creatorId) !== String(creator._id)) throw new HttpError(403, 'Not your poll');

  const rows = await IfIGoResponse.find({ ifIGoStoryId: poll._id }).sort({ createdAt: -1 });
  if (rows.length === 0) return [];
  const buyers = await Buyer.find({ _id: { $in: rows.map((r) => r.respondentId) } }).select('name username avatarUrl');
  const bMap = new Map(buyers.map((b: any) => [String(b._id), b]));
  return rows.map((r) => {
    const b = bMap.get(String(r.respondentId));
    return {
      id: String(r.respondentId),
      name: b?.name ?? null,
      username: b?.username ?? null,
      avatarUrl: b?.avatarUrl ?? null,
      selections: r.selections.map((s) => ({ optionKey: s.optionKey, label: poll.options.find((o) => o.key === s.optionKey)?.label ?? s.optionKey, status: s.status, statusLabel: statusLabel(s.optionKey, s.status) })),
      privateMessage: r.privateMessage ?? null,
      respondedAt: r.createdAt,
    };
  });
}

const CREATOR_SETTABLE_STATUSES: IfIGoResponseStatus[] = ['accepted', 'declined', 'completed'];

/**
 * Creator accepts/declines/completes ONE respondent's ONE selected option
 * (spec §12 "Accept or decline offers and requests"). Never lets the creator
 * fabricate the PUBLIC totals — this only ever touches the private
 * selections array a respondent already created; it cannot add, remove, or
 * relabel an option, and getIfIGoStory's aggregate never reads this field.
 */
export async function updateResponseStatus(
  creator: IBuyer,
  storyId: string,
  respondentId: string,
  optionKey: string,
  status: IfIGoResponseStatus
): Promise<void> {
  if (!CREATOR_SETTABLE_STATUSES.includes(status)) {
    throw new HttpError(400, `Creator can only set status to ${CREATOR_SETTABLE_STATUSES.join(', ')}`);
  }
  const poll = await IfIGoStory.findOne({ storyId });
  if (!poll) throw new HttpError(404, 'If I Go… poll not found');
  if (String(poll.creatorId) !== String(creator._id)) throw new HttpError(403, 'Not your poll');

  const response = await IfIGoResponse.findOne({ ifIGoStoryId: poll._id, respondentId });
  if (!response) throw new HttpError(404, 'Response not found');
  const selection = response.selections.find((s) => s.optionKey === optionKey);
  if (!selection) throw new HttpError(404, 'That response does not include this option');
  selection.status = status;
  selection.statusChangedAt = new Date();
  await response.save();

  const optionLabel = poll.options.find((o) => o.key === optionKey)?.label ?? optionKey;
  const event = await Event.findById(poll.eventId).select('name');
  NotificationDispatcher.dispatchAsync(
    [respondentId],
    'if_i_go_status_changed',
    displayName(creator),
    `${statusLabel(optionKey, status)}: "${optionLabel}" for ${event?.name ?? 'the event'}`,
    { storyId: String(poll.storyId), ifIGoStoryId: String(poll._id), optionKey, status },
    String(creator._id)
  );
}

/**
 * Read-only verification for "Buy me a ticket" (spec §8) — NEVER assigns or
 * fabricates a ticket. This checks whether the respondent genuinely already
 * holds a real ticket for the event (bought normally through Carrot
 * checkout, same as anyone else) and, only if so, privately flips their
 * 'buy_ticket' selection to 'completed'. If no ticket is found this throws
 * rather than pretending success (no silent fallback — the respondent needs
 * to actually complete checkout first).
 */
export async function confirmTicketPurchase(buyer: IBuyer, storyId: string): Promise<IfIGoAvailability> {
  const poll = await IfIGoStory.findOne({ storyId });
  if (!poll) throw new HttpError(404, 'If I Go… poll not found');
  const response = await IfIGoResponse.findOne({ ifIGoStoryId: poll._id, respondentId: buyer._id });
  const selection = response?.selections.find((s) => s.optionKey === 'buy_ticket');
  if (!response || !selection) throw new HttpError(400, 'Select "Buy me a ticket" before confirming a purchase');

  const held = await Ticket.exists({ eventId: poll.eventId, buyerId: buyer._id, status: { $in: [TicketStatus.SOLD, TicketStatus.CHECKED_IN] } });
  if (!held) throw new HttpError(409, 'No completed ticket purchase found for this event yet');

  selection.status = 'completed';
  selection.statusChangedAt = new Date();
  await response.save();

  const event = await Event.findById(poll.eventId).select('name');
  NotificationDispatcher.dispatchAsync(
    [String(poll.creatorId)],
    'if_i_go_status_changed',
    displayName(buyer),
    `bought a ticket to ${event?.name ?? 'your event'} for you.`,
    { storyId: String(poll.storyId), ifIGoStoryId: String(poll._id), optionKey: 'buy_ticket', status: 'completed' },
    String(buyer._id)
  );

  return getIfIGoStory(storyId, buyer);
}

const CONVERSATION_STARTERS: Record<string, (eventName: string) => string> = {
  buy_drink: (e) => `Hey! I'd love to buy you a drink at ${e} 🍹`,
  share_transport: (e) => `Hey! Want to coordinate transport for ${e}? Let's sort out a meeting point, time, and cost.`,
  go_with_me: (e) => `Hey! I'd like to go to ${e} with you — let's plan it out.`,
  ask_join_table: (e) => `Hey! I'd love for you to join my table at ${e}.`,
  join_table: (e) => `Hey! Could I join your table at ${e}?`,
};

/**
 * Real "continue through Messages" fallback (spec §9/§11) — opens (or
 * reuses) a genuine DM thread with the Story creator and posts a starter
 * message, rather than a dead link. Used for buy_drink when Carrot menu
 * gifting isn't available for the event, and for share_transport/go_with_me.
 */
export async function openConversationForOption(buyer: IBuyer, storyId: string, optionKey: string): Promise<{ threadId: string }> {
  const poll = await IfIGoStory.findOne({ storyId });
  if (!poll) throw new HttpError(404, 'If I Go… poll not found');
  if (String(poll.creatorId) === String(buyer._id)) throw new HttpError(400, "You can't message yourself");
  const creator = await Buyer.findById(poll.creatorId);
  if (!creator) throw new HttpError(404, 'Creator not found');

  const thread = await DmThreadService.openThread(buyer, [String(creator._id)]);
  const event = await Event.findById(poll.eventId).select('name');
  const starter = CONVERSATION_STARTERS[optionKey]?.(event?.name ?? 'the event');
  if (starter) {
    await MessageService.sendDmMessage(String(thread._id), { type: 'buyer', id: String(buyer._id) }, { body: starter }).catch((err) =>
      console.error('[if-i-go] conversation starter failed:', err)
    );
  }
  return { threadId: String(thread._id) };
}

export interface OwnedPlanDto { id: string; name: string; visibility: string }

/** The buyer's own active Event Plans for this poll's event — lets the
 *  frontend offer real deep-links into the EXISTING Event Plan flows
 *  (join/invite/create) for join_table/ask_join_table/go_with_me (spec
 *  §10/§11) instead of this feature re-implementing table membership. */
export async function listOwnPlansForEvent(buyer: IBuyer, storyId: string): Promise<OwnedPlanDto[]> {
  const poll = await IfIGoStory.findOne({ storyId }).select('eventId');
  if (!poll) throw new HttpError(404, 'If I Go… poll not found');
  const plans = await EventPlan.find({ eventId: poll.eventId, adminId: buyer._id, status: 'active' }).select('name visibility');
  return plans.map((p: any) => ({ id: String(p._id), name: p.name, visibility: p.visibility }));
}
