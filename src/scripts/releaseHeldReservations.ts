/**
 * Cutover drain for multi-tier checkout.
 *
 * Run ONCE, immediately BEFORE deploying the multi-tier revision. It does two
 * things, both so the new code never meets a document written by the old one
 * and no compatibility branch is needed anywhere on the payment path:
 *
 *   1. Resolves every in-flight PENDING sale, by asking each rail's own
 *      reconciler. A sale created before this deploy has no `TicketSale.lines`,
 *      and the new finalizers REFUSE to mint without it (they would otherwise
 *      have to guess the tier and price). Settling them first means none is
 *      left for a webhook to land on afterwards.
 *
 *   2. Releases every still-held reservation through the pre-change field
 *      shape, restoring each tier's `reserved` count, so no old-shaped held
 *      document survives into the `lines[]` world.
 *
 * Why a drain and not a fallback: reservations are short-lived by
 * construction, `confirmed`/`released` rows are inert history nothing reads
 * again, and "delete the compatibility branch next cycle" reliably becomes
 * permanent. A short drain buys the same safety with no code.
 *
 * Cost: a buyer mid-checkout at cutover loses their inventory hold and must
 * re-select. Their PAYMENT is not lost — step 1 settles anything already
 * authorised before the holds are released. Run it in a low-traffic window.
 *
 * Idempotent: a second run finds nothing pending and nothing held.
 *
 * Usage:
 *   MONGODB_URI='...' npx ts-node -r tsconfig-paths/register src/scripts/releaseHeldReservations.ts
 */
import mongoose from 'mongoose';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { TicketService } from '@services/ticket.service';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

interface LegacyLine { ticketTypeId: string; quantity: number }

/**
 * Step 1 — let each rail settle its own outstanding sales.
 *
 * Every reconciler is `olderThanMs`-gated so it will not disturb a payment
 * that is still legitimately in progress; passing 0 tells them to consider
 * everything, which is what a cutover wants.
 *
 * Yoco has no status-query endpoint at all — a signed webhook is its only
 * truth — so it can only be REPORTED, not resolved. Any Yoco sale still
 * pending after this must be settled by hand before deploying, and the script
 * says so loudly rather than pretending it handled it.
 */
async function settlePendingSales(): Promise<void> {
  console.log('\n— step 1: settling in-flight PENDING sales —');

  const card = await TicketService.reconcilePendingCardSales(0);
  console.log(`  peach card:  ${card} resolved`);

  const deltapay = await TicketService.reconcilePendingDeltapaySales(0);
  console.log(`  deltapay:    ${deltapay} resolved`);

  const yebopay = await TicketService.reconcilePendingYeboPaySales(0);
  console.log(`  yebopay:     minted ${yebopay.minted}, failed ${yebopay.failed}, still pending ${yebopay.pending}`);

  const yocoStuck = await TicketService.reportStuckYocoSales(0);
  if (yocoStuck > 0) {
    console.warn(`  yoco:        ${yocoStuck} still PENDING — Yoco publishes no status API, so these CANNOT be resolved automatically.`);
  } else {
    console.log('  yoco:        0 pending');
  }

  // MoMo has no batch reconciler; finalize each outstanding sale by its own
  // MTN reference, which is idempotent.
  const momo = await TicketSale.find({
    paymentMethod: PaymentMethod.MTN_MOMO,
    paymentStatus: PaymentStatus.PENDING,
    momoReferenceId: { $exists: true, $ne: null },
  }).select('momoReferenceId').lean();
  let momoResolved = 0;
  for (const s of momo) {
    try {
      const { status } = await TicketService.finalizeMomoSale(String(s['momoReferenceId']));
      if (status !== 'pending') momoResolved++;
    } catch (e: any) {
      console.warn(`  momo ${String(s['momoReferenceId'])}: ${e?.message}`);
    }
  }
  console.log(`  mtn momo:    ${momoResolved}/${momo.length} resolved`);

  const stillPending = await TicketSale.countDocuments({
    paymentStatus: PaymentStatus.PENDING,
    lines: { $exists: false },
  });
  if (stillPending > 0) {
    console.warn(
      `\n  ⚠️  ${stillPending} PENDING sale(s) remain with no lines[]. Deploying now means ` +
      `any webhook that lands for them will REFUSE to mint. Settle them by hand first.`
    );
  } else {
    console.log('\n  ✓ no PENDING sale is left without a composition snapshot');
  }
}

/** Step 2 — release held reservations written in the pre-`lines[]` shape. */
async function releaseHolds(): Promise<void> {
  console.log('\n— step 2: releasing held reservations —');

  // Read through the raw collection, not the model: the model now describes
  // the NEW shape, and this script exists precisely to handle the old one.
  const coll = mongoose.connection.db!.collection('ticketreservations');
  const held = await coll.find({ status: 'held' }).toArray();
  console.log(`  held reservations to drain: ${held.length}`);

  let drained = 0;
  let orphaned = 0;

  for (const r of held) {
    const legacyLines: LegacyLine[] = Array.isArray(r['lines'])
      ? (r['lines'] as LegacyLine[])
      : [{ ticketTypeId: String(r['ticketTypeId']), quantity: Number(r['quantity']) }];

    const event = await Event.findById(r['eventId']);
    if (!event) {
      console.warn(`  reservation ${String(r['_id'])}: event ${String(r['eventId'])} not found — releasing anyway`);
      await coll.updateOne({ _id: r['_id'] }, { $set: { status: 'released' } });
      orphaned++;
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

  console.log(`  drained: ${drained}, released-without-event: ${orphaned}`);
}

async function main(): Promise<void> {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri);

  // Order matters: settle payments BEFORE releasing the inventory they hold,
  // or a sale could mint against seats already handed back.
  await settlePendingSales();
  await releaseHolds();

  console.log('\ndrain complete — safe to deploy multi-tier checkout.');
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('drain failed:', e);
  process.exit(1);
});
