import mongoose from 'mongoose';
import { Event } from '@models/event.model';

/** One-time, idempotent: organizer-created/updated events are now locked to
 *  `ticketing: 'carrot'` at the controller layer, but pre-existing events
 *  persisted with `ticketing: 'external'` are untouched by that change and
 *  still redirect buyers off-platform on the landing site. Flips every such
 *  event to 'carrot' and clears the now-irrelevant external-only fields. */
export async function backfillExternalTicketing(): Promise<{ updated: number }> {
  const res = await Event.updateMany(
    { ticketing: 'external' },
    {
      $set: { ticketing: 'carrot' },
      $unset: { externalTicketUrl: '', priceMin: '', priceMax: '' },
    },
  );
  return { updated: res.modifiedCount };
}

if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    console.log('[backfillExternalTicketing] done:', await backfillExternalTicketing());
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillExternalTicketing] failed:', err);
    process.exit(1);
  });
}
