import express from 'express';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getObject, putObject, publicUrl } from './r2';
import { buildRenditionArgs, buildPosterArgs, runFfmpeg, buildProbeArgs, runProbe, parseProbe } from './ffmpeg';
import { connect, Update, StoryTarget } from './db';
import { renditionKeyPrefix, readyUpdateOps, failedUpdateOps, type MediaCollection } from './mediaTarget';
import { applyResult } from './writeResult';

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

app.post('/transcode', async (req, res) => {
  const secret = process.env.TRANSCODER_SHARED_SECRET;
  if (!secret || req.header('x-transcoder-secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  const { updateId, rawKey, collection } = req.body || {};
  if (!updateId || !rawKey) return res.status(400).json({ error: 'updateId and rawKey required' });
  // Defaults to 'updates' for backward compat with any in-flight caller that
  // predates this field — everything on the api side now sends it explicitly.
  const target: MediaCollection = collection === 'stories' ? 'stories' : 'updates';
  res.status(202).json({ accepted: true });          // ack immediately; work continues async
  process.nextTick(() => transcode(updateId, rawKey, target).catch((e) => console.error('transcode job failed:', e?.message)));
});

async function transcode(updateId: string, rawKey: string, collection: MediaCollection): Promise<void> {
  await connect();
  const Model = collection === 'stories' ? StoryTarget : Update;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tc-'));
  const input = path.join(dir, 'in');
  try {
    await fs.writeFile(input, await getObject(rawKey));
    const p720 = path.join(dir, '720.mp4'); const p480 = path.join(dir, '480.mp4'); const pj = path.join(dir, 'poster.jpg');
    await runFfmpeg(buildRenditionArgs(input, p720, 1280));
    await runFfmpeg(buildRenditionArgs(input, p480, 854));
    await runFfmpeg(buildPosterArgs(input, pj));
    const { width, height, durationSec } = parseProbe(await runProbe(buildProbeArgs(p720)));
    const prefix = renditionKeyPrefix(collection, updateId);
    const k720 = `${prefix}/720.mp4`, k480 = `${prefix}/480.mp4`, kp = `${prefix}/poster.jpg`;
    await putObject(k720, await fs.readFile(p720), 'video/mp4');
    await putObject(k480, await fs.readFile(p480), 'video/mp4');
    await putObject(kp, await fs.readFile(pj), 'image/jpeg');
    await applyResult(Model, updateId, collection, readyUpdateOps(collection, { url: publicUrl(k720), url480: publicUrl(k480), poster: publicUrl(kp), width, height, durationSec }));
  } catch (err: any) {
    // The failure write gets the same zero-match guard, but its own throw is
    // swallowed and logged: we are already unwinding a real error, and
    // replacing it with "couldn't record the error" would lose the cause.
    try {
      await applyResult(Model, updateId, collection, failedUpdateOps(collection, err?.message?.slice(0, 400) || 'transcode failed'));
    } catch (writeErr: any) {
      console.error('could not record transcode failure:', writeErr?.message);
    }
    throw err;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`transcoder on :${port}`));
