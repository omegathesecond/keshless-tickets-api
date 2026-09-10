/**
 * Seed the DEV environment with a test organizer, published events and a buyer.
 *
 * SAFETY — read before changing anything here:
 *
 * This script REFUSES to run against any database whose name is not exactly
 * `carrot-tickets-dev`. That guard is the whole reason this file exists rather
 * than reusing `seedTestData.ts`, which calls `deleteMany({})` on Vendors and
 * Events with no check on where it is pointed — run it with production env
 * loaded and it wipes every organizer and event on the platform.
 *
 * This script is also NON-DESTRUCTIVE and idempotent: it upserts by natural key
 * and deletes nothing, so re-running it is safe and tops the environment back up
 * rather than resetting it.
 *
 * Credentials are read from the environment, never hard-coded, so no test
 * password is ever committed to the repository.
 *
 * Usage (values supplied at the call site, not stored here):
 *   MONGODB_URI='<dev uri>' \
 *   SEED_BUYER_PHONE='+268...' SEED_BUYER_PASSWORD='...' SEED_BUYER_NAME='...' \
 *   SEED_VENDOR_EMAIL='...' SEED_VENDOR_PASSWORD='...' \
 *   npx ts-node -r tsconfig-paths/register src/scripts/seedDevEnvironment.ts
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Vendor } from '../models/vendor.model';
import { Event } from '../models/event.model';
import { Buyer } from '../models/buyer.model';
import { EventStatus } from '../interfaces/event.interface';
import type { EventCategory } from '../constants/eventCategories';
import { normalizePhone } from '../utils/phone.util';

dotenv.config();

/** The ONLY database this script may touch. */
const ALLOWED_DB_NAME = 'carrot-tickets-dev';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required — refusing to guess.`);
  return v;
}

/** Days from now, at a given local hour. */
function futureDate(days: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

// `category` is typed to EventCategory so an invalid value fails at COMPILE time.
// Without it, a bad category only surfaces as a mongoose enum error partway
// through seeding — after some documents have already been written.
interface SeedEvent {
  name: string;
  description: string;
  venue: string;
  category: EventCategory;
  inDays: number;
  startHour: number;
  endHour: number;
  ticketTypes: Array<{ name: string; price: number; quantity: number }>;
}

const EVENTS: SeedEvent[] = [
  {
    name: 'Bushfire Warm-Up Session',
    description: 'An intimate acoustic evening ahead of the main festival. Test event — dev only.',
    venue: 'House On Fire, Malkerns',
    category: 'Music',
    inDays: 14,
    startHour: 18,
    endHour: 23,
    ticketTypes: [
      { name: 'General', price: 150, quantity: 200 },
      { name: 'VIP', price: 400, quantity: 40 },
    ],
  },
  {
    name: 'Eswatini Tech Meetup',
    description: 'Monthly gathering for developers and founders. Test event — dev only.',
    venue: 'The Hub, Mbabane',
    category: 'Tech',
    inDays: 7,
    startHour: 17,
    endHour: 20,
    ticketTypes: [
      { name: 'Standard', price: 0, quantity: 120 },
      { name: 'Supporter', price: 100, quantity: 30 },
    ],
  },
  {
    name: 'Sibebe Sunrise Hike',
    description: 'Guided early-morning hike up Sibebe Rock. Test event — dev only.',
    venue: 'Sibebe Rock, Pine Valley',
    category: 'Sports',
    inDays: 21,
    startHour: 5,
    endHour: 10,
    ticketTypes: [{ name: 'Entry', price: 80, quantity: 60 }],
  },
];

async function seed(): Promise<void> {
  const uri = requireEnv('MONGODB_URI');
  const buyerPhone = normalizePhone(requireEnv('SEED_BUYER_PHONE'));
  const buyerPassword = requireEnv('SEED_BUYER_PASSWORD');
  const vendorEmail = requireEnv('SEED_VENDOR_EMAIL');
  const vendorPassword = requireEnv('SEED_VENDOR_PASSWORD');

  await mongoose.connect(uri);

  // ── The guard. Checked AFTER connecting so we read the database we are
  // actually attached to, not one parsed out of a URI string that might be
  // shaped unexpectedly. Never relax this to a substring match: a production
  // database named `carrot-tickets-dev-backup` would slip through.
  const dbName = mongoose.connection.db?.databaseName;
  if (dbName !== ALLOWED_DB_NAME) {
    await mongoose.disconnect();
    throw new Error(
      `REFUSING TO SEED: connected to database "${dbName}", but this script only ` +
        `runs against "${ALLOWED_DB_NAME}". Check MONGODB_URI.`
    );
  }
  console.log(`✅ Connected to ${dbName} (guard passed)\n`);

  // ── Organizer ────────────────────────────────────────────────────────────
  // Upsert by email so re-runs top up rather than duplicate. `password` is set
  // via save() (not updateOne) so the model's pre-save bcrypt hook runs — an
  // updateOne would store the plaintext.
  let vendor = await Vendor.findOne({ email: vendorEmail });
  if (!vendor) {
    vendor = new Vendor({
      email: vendorEmail,
      phoneNumber: '+26878000001',
      businessName: 'Carrot Dev Events',
      isActive: true,
      verificationStatus: 'verified',
      apps: {
        keshless: { enabled: false },
        tickets: { enabled: true, activatedAt: new Date() },
      },
    });
  }
  vendor.password = vendorPassword;
  await vendor.save();
  console.log(`👤 Organizer ready: ${vendorEmail} (id ${vendor._id})`);

  // ── Buyer ────────────────────────────────────────────────────────────────
  // Same reasoning: assign then save() so the bcrypt pre-save hook hashes it.
  let buyer = await Buyer.findOne({ phone: buyerPhone });
  if (!buyer) {
    // Name is set on CREATION only — re-running with an existing phone updates
    // the password but never overwrites a name the buyer may have changed.
    buyer = new Buyer({ phone: buyerPhone, name: process.env['SEED_BUYER_NAME'] || 'Dev Buyer' });
  }
  buyer.password = buyerPassword;
  // A real buyer only gets this via OTP-gated registration (see
  // BuyerAuthService.registerWithOtp) — set it here too so a seeded buyer is
  // indistinguishable from one that actually proved phone ownership.
  if (!buyer.phoneVerifiedAt) buyer.phoneVerifiedAt = new Date();
  await buyer.save();
  console.log(`🎟️  Buyer ready: ${buyerPhone} (id ${buyer._id})`);

  // ── Events ───────────────────────────────────────────────────────────────
  let created = 0;
  for (const e of EVENTS) {
    const existing = await Event.findOne({ name: e.name, vendorId: vendor._id });
    if (existing) {
      console.log(`   • ${e.name} — already present, left alone`);
      continue;
    }
    const eventDate = futureDate(e.inDays, e.startHour);
    await Event.create({
      vendorId: vendor._id,
      name: e.name,
      description: e.description,
      venue: e.venue,
      category: e.category,
      eventDate,
      startTime: eventDate,
      endTime: futureDate(e.inDays, e.endHour),
      status: EventStatus.PUBLISHED,
      publishedAt: new Date(),
      ticketing: 'carrot',
      ticketTypes: e.ticketTypes.map(t => ({ ...t, sold: 0, reserved: 0 })),
    });
    created++;
    console.log(`   • ${e.name} — created`);
  }

  const total = await Event.countDocuments({ status: EventStatus.PUBLISHED });
  console.log(`\n🎫 ${created} event(s) created; ${total} published event(s) in dev.`);

  await mongoose.disconnect();
}

seed()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n❌ Seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
