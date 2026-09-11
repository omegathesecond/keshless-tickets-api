import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Update } from '@models/update.model';
import { Story } from '@models/story.model';
import { reconcileStuckUpdates, reconcileStuckStories } from '@services/transcode.client';
import mongoose from 'mongoose';

describe('reconcileStuckUpdates', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('marks a >30min-stuck processing video as failed (fail-loud)', async () => {
    const u = await Update.create({
      authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'video', caption: '',
      media: [{ rawKey: 'k', status: 'processing', processingStartedAt: new Date(Date.now() - 31 * 60000) }],
    });
    await reconcileStuckUpdates();
    const after = await Update.findById(u.id);
    expect(after!.media[0]!.status).toBe('failed');
    expect(after!.media[0]!.error).toBeTruthy();
  });

  it('leaves a fresh processing update alone', async () => {
    const u = await Update.create({
      authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'video', caption: '',
      media: [{ rawKey: 'k', status: 'processing', processingStartedAt: new Date() }],
    });
    await reconcileStuckUpdates();
    const after = await Update.findById(u.id);
    expect(after!.media[0]!.status).toBe('processing');
  });
});

describe('reconcileStuckStories', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('marks a >30min-stuck processing video Story as failed (fail-loud, not a silent TTL-expiry)', async () => {
    const s = await Story.create({
      authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'video',
      media: { rawKey: 'k', status: 'processing', processingStartedAt: new Date(Date.now() - 31 * 60000) },
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });
    await reconcileStuckStories();
    const after = await Story.findById(s.id);
    expect(after!.media!.status).toBe('failed');
    expect(after!.media!.error).toBeTruthy();
  });

  it('leaves a fresh processing video Story alone', async () => {
    const s = await Story.create({
      authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'video',
      media: { rawKey: 'k', status: 'processing', processingStartedAt: new Date() },
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });
    await reconcileStuckStories();
    const after = await Story.findById(s.id);
    expect(after!.media!.status).toBe('processing');
  });

  it('never touches a processing image Story (images finalize synchronously, never go through the transcoder)', async () => {
    const s = await Story.create({
      authorType: 'buyer', authorId: new mongoose.Types.ObjectId(), kind: 'image',
      media: { rawKey: 'k', status: 'processing', processingStartedAt: new Date(Date.now() - 31 * 60000) },
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });
    await reconcileStuckStories();
    const after = await Story.findById(s.id);
    expect(after!.media!.status).toBe('processing');
  });
});
