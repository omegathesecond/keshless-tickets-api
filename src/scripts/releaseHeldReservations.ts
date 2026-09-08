/**
 * Cutover drain for the TicketReservation `lines[]` change.
 *
 * Run ONCE, immediately BEFORE deploying the revision that introduces
 * `lines[]` (multi-tier checkout, slice 1). It releases every still-held
 * reservation using the pre-change field shape, restoring each tier's
 * `reserved` count, so the new code never meets an old-shaped held document
 * and no dual-read compatibility path is needed anywhere on the payment path.
 *
 * Why a drain and not a fallback: reservations are short-lived by
 * construction, `confirmed`/`released` rows are inert history nothing reads
 * again, and "delete the compatibility branch next cycle" reliably becomes
 * permanent. A 30-second drain buys the same safety with no code.
 *
 * Cost: a buyer mid-checkout at cutover loses their inventory hold and must
 * re-select. Their PAYMENT is unaffected — an already-authorised sale is
 * resolved by its rail's finalizer/reconciler, which never consults the
 * reservation. Run it in a low-traffic window.
 *
 * Idempotent: a second run finds nothing held and does nothing.
 *
 * Usage:
 *   MONGODB_URI='...' npx ts-node -r tsconfig-paths/register src/scripts/releaseHeldReservations.ts
 */
import mongoose from 'mongoose';
import { Event } from '@models/event.model';

interface LegacyLine { ticketTypeId: string; quantity: number }

async function main(): Promise<void> {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri);

  // Read through the raw collection, not the model: the model now describes
  // the NEW shape, and this script exists precisely to handle the old one.
  const coll = mongoose.connection.db!.collection('ticketreservations');
  const held = await coll.find({ status: 'held' }).toArray();
  console.log(`held reservations to drain: ${held.length}`);

  let drained = 0;
  let skipped = 0;

  for (const r of held) {
    const legacyLines: LegacyLine[] = Array.isArray(r['lines'])
      ? (r['lines'] as LegacyLine[])
      : [{ ticketTypeId: String(r['ticketTypeId']), quantity: Number(r['quantity']) }];

    const event = await Event.findById(r['eventId']);
    if (!event) {
      // The event is gone; the hold is meaningless. Mark it released so the
      // row cannot be picked up again, but say so rather than failing quietly.
      console.warn(`  reservation ${String(r['_id'])}: event ${String(r['eventId'])} not found — releasing anyway`);
      await coll.updateOne({ _id: r['_id'] }, { $set: { status: 'released' } });
      skipped++;
      continue;
    }

    for (const line of legacyLines) {
      const tt = event.ticketTypes.find((t) => t._id?.toString() === line.ticketTypeId);
      if (!tt) {
        console.warn(`  reservation ${String(r['_id'])}: tier ${line.ticketTypeId} not on event — skipping that line`);
        continue;
      }
      tt.reserved = Math.max(0, (tt.reserved || 0) - line.quantity);
    }
    await event.save(); // pre-save hook recomputes `available`

    await coll.updateOne({ _id: r['_id'] }, { $set: { status: 'released' } });
    drained++;
  }

  console.log(`drained: ${drained}, released-without-event: ${skipped}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('drain failed:', e);
  process.exit(1);
});
