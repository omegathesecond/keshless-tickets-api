/**
 * Cutover step for multi-tier checkout. Run ONCE, immediately BEFORE the
 * deploy that introduces `TicketSale.lines`.
 *
 * The five async rails create a PENDING sale now and mint from a webhook
 * later. After this deploy their finalizers mint from `sale.lines` and REFUSE
 * to mint without it (see mintSettledSaleTickets) — so a sale created by the
 * old build, whose payment settles after the deploy, would be stranded: money
 * taken, no ticket.
 *
 * Rather than settling or failing those sales, this recovers what they were:
 * every sale still has its TicketReservation (status 'released' or
 * 'confirmed' — the row survives, only the hold is gone), and the reservation
 * names the tier. With the tier and the sale's own quantity and totalAmount,
 * the composition is exact.
 *
 * That is strictly safer than the alternative of asking each rail to settle
 * its outstanding sales, which would resolve real customer payments during a
 * deploy window. This script touches NO payment state: it only adds a field
 * that describes what was already bought.
 *
 * Idempotent: sales that already carry `lines` are skipped, so a second run
 * does nothing.
 *
 * A sale whose tier cannot be recovered is REPORTED, never guessed — minting
 * the wrong ticket for real money is worse than a loud failure. Settle those
 * by hand before deploying.
 *
 * Usage:
 *   MONGODB_URI='...' npx ts-node -r tsconfig-paths/register src/scripts/backfillSaleLines.ts
 *   MONGODB_URI='...' npx ts-node -r tsconfig-paths/register src/scripts/backfillSaleLines.ts --apply
 *
 * Without --apply it is a dry run: it prints exactly what it would write.
 */
import mongoose from 'mongoose';

interface Recovered {
  saleId: mongoose.Types.ObjectId;
  method: string;
  line: { ticketTypeId: string; ticketTypeName: string; unitPrice: number; quantity: number };
}

async function main(): Promise<void> {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is required');
  const apply = process.argv.includes('--apply');

  await mongoose.connect(uri);
  const db = mongoose.connection.db!;

  const sales = await db.collection('ticketsales')
    .find({ paymentStatus: 'pending', lines: { $exists: false } })
    .toArray();

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — lines-less PENDING sales: ${sales.length}\n`);

  const recovered: Recovered[] = [];
  const unrecoverable: string[] = [];

  for (const sale of sales) {
    const reservation = await db.collection('ticketreservations').findOne({ saleId: sale['_id'] });
    const ticketTypeId = reservation
      ? String(Array.isArray(reservation['lines'])
          ? reservation['lines'][0]?.ticketTypeId
          : reservation['ticketTypeId'])
      : null;

    const event = await db.collection('events').findOne({ _id: sale['eventId'] });
    const tier = ticketTypeId
      ? (event?.['ticketTypes'] as Array<Record<string, unknown>> | undefined)
          ?.find((t) => String(t['_id']) === ticketTypeId)
      : undefined;

    const quantity = Number(sale['quantity']) || 0;
    if (!ticketTypeId || !tier || quantity < 1) {
      unrecoverable.push(String(sale['_id']));
      console.warn(`  ✗ ${String(sale['_id'])} — cannot recover its tier; settle this one by hand`);
      continue;
    }

    // Single-tier by construction (these predate multi-tier), so the unit
    // price is exact rather than an average.
    const unitPrice = Math.round((Number(sale['totalAmount']) / quantity) * 100) / 100;

    recovered.push({
      saleId: sale['_id'] as mongoose.Types.ObjectId,
      method: String(sale['paymentMethod']),
      line: { ticketTypeId, ticketTypeName: String(tier['name']), unitPrice, quantity },
    });
    console.log(
      `  ✓ ${String(sale['_id'])} ${String(sale['paymentMethod']).padEnd(8)} ` +
      `${quantity} × ${String(tier['name'])} @ ${unitPrice}`
    );
  }

  if (apply) {
    for (const r of recovered) {
      await db.collection('ticketsales').updateOne(
        { _id: r.saleId, lines: { $exists: false } }, // idempotent
        { $set: { lines: [r.line] } }
      );
    }
    console.log(`\nwrote lines[] to ${recovered.length} sale(s)`);
  } else {
    console.log(`\nwould write lines[] to ${recovered.length} sale(s) — re-run with --apply`);
  }

  if (unrecoverable.length) {
    console.warn(
      `\n⚠️  ${unrecoverable.length} sale(s) could not be recovered. Deploying now means a ` +
      `webhook landing for them will refuse to mint:\n   ${unrecoverable.join('\n   ')}`
    );
  } else {
    console.log('\n✓ every lines-less PENDING sale is now described — safe to deploy.');
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('backfill failed:', e);
  process.exit(1);
});
