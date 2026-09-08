import { applyResult } from '../writeResult';

/** A stand-in for the mongoose model, so these tests need no database. */
function modelMatching(matchedCount: number) {
  const calls: unknown[][] = [];
  return {
    calls,
    async updateOne(filter: unknown, update: unknown) {
      calls.push([filter, update]);
      return { matchedCount, modifiedCount: matchedCount };
    },
  };
}

describe('applyResult', () => {
  it('writes the ops to the document it was given', async () => {
    const model = modelMatching(1);
    await applyResult(model, '6a9ee42a9988b9571aeb471b', 'stories', { 'media.status': 'ready' });

    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.[0]).toEqual({ _id: '6a9ee42a9988b9571aeb471b' });
    expect(model.calls[0]?.[1]).toEqual({ $set: { 'media.status': 'ready' } });
  });

  // The regression this whole module exists for: a transcoder image that
  // predates `collection` routing wrote every story's result into the
  // `updates` collection, where the story's _id matched nothing. Mongo
  // reports that as a perfectly successful write, so the job "succeeded"
  // for five days while no video Story ever left 'processing'.
  it('THROWS when the write matched no document, instead of reporting success', async () => {
    const model = modelMatching(0);

    await expect(
      applyResult(model, '6a9ee42a9988b9571aeb471b', 'stories', { 'media.status': 'ready' }),
    ).rejects.toThrow(/no document matched/i);
  });

  it('names the collection and id in the error, so the mismatch is obvious', async () => {
    const model = modelMatching(0);

    await expect(
      applyResult(model, 'abc123', 'updates', { 'media.0.status': 'ready' }),
    ).rejects.toThrow(/updates.*abc123|abc123.*updates/is);
  });
});
