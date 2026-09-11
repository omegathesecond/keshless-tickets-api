import { Update } from '@models/update.model';
import { Story } from '@models/story.model';

/**
 * Minimal shape triggerTranscode needs — an id, a raw R2 key, and which
 * collection to write the result back to. IUpdate and IStory both carry a
 * `media` shape that's structurally compatible once wrapped (Update.media is
 * already an array; Story.media is a single embedded doc, wrapped as a
 * one-item array — see finalizeStory in @services/story.service).
 *
 * `collection` is REQUIRED, not defaulted: the separate transcoder
 * microservice (transcoder/src/index.ts) uses it to pick which document
 * (and which field path — Update's `media.0.*` vs Story's `media.*`) to
 * write the ready/failed result back to. Before this field existed, every
 * call wrote to the hardcoded `updates` collection at `media.0.*`, which
 * silently wedged every video Story in 'processing' forever (see the git
 * history of finalizeStory's CAVEAT comment).
 */
export interface Transcodable {
  id?: unknown; // mongoose's Document.id is itself optional/`any` — matched here so real docs satisfy this structurally
  media: { rawKey: string }[]; // videos are always a single item — media[0]
  collection: 'updates' | 'stories';
}

export async function triggerTranscode(target: Transcodable): Promise<void> {
  const url = process.env['TRANSCODER_URL'];
  const secret = process.env['TRANSCODER_SHARED_SECRET'];
  if (!url || !secret) throw new Error('TRANSCODER_URL / TRANSCODER_SHARED_SECRET not configured');
  const rawKey = target.media[0]?.rawKey;
  if (!rawKey) throw new Error('Transcodable has no media[0].rawKey');
  const res = await fetch(`${url}/transcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-transcoder-secret': secret },
    body: JSON.stringify({ updateId: String(target.id), rawKey, collection: target.collection }),
  });
  if (!res.ok) throw new Error(`Transcoder responded ${res.status}`);
}

export async function reconcileStuckUpdates(): Promise<void> {
  const now = Date.now();
  const retryBefore = new Date(now - 10 * 60000);
  const failBefore = new Date(now - 30 * 60000);
  const stuck = await Update.find({ kind: 'video', 'media.status': 'processing' }).select('_id media').lean();
  for (const u of stuck) {
    const started = u.media?.[0]?.processingStartedAt ? new Date(u.media[0].processingStartedAt).getTime() : now;
    if (started < failBefore.getTime()) {
      await Update.updateOne({ _id: u._id }, { $set: { 'media.0.status': 'failed', 'media.0.error': 'transcode timed out' } });
    } else if (started < retryBefore.getTime()) {
      const full = await Update.findById(u._id);
      if (full) triggerTranscode({ id: full.id, media: full.media, collection: 'updates' }).catch((e) => console.error('re-trigger transcode failed:', e?.message));
    }
  }
}

/**
 * Same sweep as reconcileStuckUpdates, for Story's single embedded `media`
 * doc instead of Update's `media` array. Without this, a video Story whose
 * transcode job crashed (or never got dispatched — a transient
 * TRANSCODER_URL misconfig, a dropped request) stays 'processing' until its
 * 48h TTL quietly deletes it — the author never learns it failed. This flips
 * it to 'failed' after 30min so listForViewer can surface that to its
 * author (own items are never ready-filtered — see listForViewer), and
 * retries once (10-30min window) in case the first dispatch simply never
 * landed.
 */
export async function reconcileStuckStories(): Promise<void> {
  const now = Date.now();
  const retryBefore = new Date(now - 10 * 60000);
  const failBefore = new Date(now - 30 * 60000);
  const stuck = await Story.find({ kind: 'video', 'media.status': 'processing' }).select('_id media').lean();
  for (const s of stuck) {
    const started = s.media?.processingStartedAt ? new Date(s.media.processingStartedAt).getTime() : now;
    if (started < failBefore.getTime()) {
      await Story.updateOne({ _id: s._id }, { $set: { 'media.status': 'failed', 'media.error': 'transcode timed out' } });
    } else if (started < retryBefore.getTime()) {
      const full = await Story.findById(s._id);
      // kind:'video' in the query above guarantees media is present — only
      // 'if_i_go' Stories can ever have no media (see @models/story.model).
      if (full?.media) triggerTranscode({ id: full.id, media: [{ rawKey: full.media.rawKey }], collection: 'stories' }).catch((e) => console.error('re-trigger transcode (story) failed:', e?.message));
    }
  }
}
