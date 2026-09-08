import type { MediaCollection } from './mediaTarget';

/** The slice of a mongoose Model this module needs — kept structural so the
 *  tests can drive it without a database. */
export interface ResultWritable {
  updateOne(filter: unknown, update: unknown): Promise<{ matchedCount: number }>;
}

/**
 * Applies one transcode result, and refuses to treat a write that matched
 * NOTHING as a success.
 *
 * This guard exists because of a real five-day outage. A transcoder image
 * built from a stale working tree predated `collection` routing and wrote
 * every result to the `updates` collection — so a Story's `_id`, looked up
 * in `updates`, matched no document. Mongo is perfectly happy with that:
 * `updateOne` returns `{ matchedCount: 0 }`, not an error. The job therefore
 * transcoded the video, uploaded three renditions to R2, reported success,
 * and left the Story sitting in 'processing' until the reconcile sweep gave
 * up 30 minutes later and marked it 'transcode timed out' — a message that
 * describes a timeout that never happened and points nowhere near the cause.
 *
 * A zero-match write is never legitimate here: the document was read moments
 * earlier by the API to dispatch this very job. So matching nothing means we
 * are writing to the wrong place, and that must be loud (the project's
 * standing rule: never let a failure look like a success).
 */
export async function applyResult(
  model: ResultWritable,
  id: string,
  collection: MediaCollection,
  ops: Record<string, unknown>,
): Promise<void> {
  const res = await model.updateOne({ _id: id }, { $set: ops });
  if (res.matchedCount === 0) {
    throw new Error(
      `transcode result discarded: no document matched _id=${id} in collection '${collection}'. ` +
      `The media was processed but nothing was updated — this is what a transcoder built ` +
      `from a stale tree looks like. Redeploy the transcoder from origin/main.`,
    );
  }
}
