import { Schema, model, Document } from 'mongoose';
import bcrypt from 'bcrypt';

/** Canonical username shape. Lives on the model so the schema validator and
 *  the generator in @utils/username.util share one definition (the util
 *  imports from here — the reverse would be a circular import). */
export const USERNAME_REGEX = /^[a-z0-9_.]{3,20}$/;

/** How often a buyer may change their profile `name` — see `nameChangedAt`. */
export const NAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export interface NotificationPrefs {
  announcements: boolean;
  dms: boolean;
  mentions: boolean;
  social: boolean;
  reminders: boolean;
}

/** GeoJSON Point. Coordinate order is [lng, lat] per the GeoJSON spec (and
 *  what MongoDB's 2dsphere index / $geoNear expect) — NOT [lat, lng]. */
export interface IBuyerLocation {
  type: 'Point';
  coordinates: [number, number]; // [lng, lat]
}

/**
 * Buyer (ticket-holder) account for the public site.
 *
 * Buyers authenticate with phone or email + password — no SMS one-time codes.
 * The _id is the unique identity (tickets are keyed off _id via customerPhone lookup).
 * Phone and email are verified handles; buyers must have at least one to receive tickets.
 * Passwords are bcrypt-hashed via the pre-save hook and are never returned by default (`select: false`).
 */
export interface IBuyer extends Document {
  phone?: string; // normalised, e.g. +26878422613 (optional — email-only buyers have none)
  email?: string; // lowercased, unique among buyers with an email
  emailVerifiedAt?: Date;
  phoneVerifiedAt?: Date;
  password: string; // bcrypt hash (select: false)
  name?: string;
  // Set whenever `name` is changed by the buyer (not on the initial signup
  // value). Drives the 30-day cooldown in SocialProfileController.update —
  // see NAME_CHANGE_COOLDOWN_MS. Left unset for buyers who have never
  // renamed themselves post-signup, so they are never gated on first edit.
  nameChangedAt?: Date;
  avatarUrl?: string; // public R2 URL of the buyer's profile picture (optional)
  username?: string; // unique social handle, auto-generated on first social touch
  bio?: string;
  // Free-text home city (no capture flow yet — set directly for now). Used as
  // a "people you may know" ranking signal (@services/suggestions.service);
  // absent for most buyers until a profile-settings field writes it.
  city?: string;
  dmPrivacy: 'community' | 'friends';
  notificationPrefs: NotificationPrefs;
  usernameCustomizedAt?: Date; // set when the buyer picks their own handle
  lastLoginAt?: Date;
  // Platform-wide social suspension (Plan 7 Task 3) — set by a Carrot admin
  // resolving a report (tickets:moderate_social). Blocks social WRITES only
  // (see assertNotSuspended in @utils/socialSuspension.util); ticket
  // ownership, lookup, QR and purchase are never affected.
  socialSuspendedAt?: Date | null;
  // Nearby-people opt-in (v1). Absent for most buyers — sharing location is
  // an explicit action (PATCH /api/social/me/location), never inferred or
  // defaulted. A sparse 2dsphere index below means buyers without a location
  // are simply invisible to $geoNear, no extra filtering needed.
  location?: IBuyerLocation;
  locationUpdatedAt?: Date;
  // Profile-view-history privacy toggle (My Account tab, spec §6). When true,
  // this buyer's own views of OTHER accounts (profile/story/post) are simply
  // never recorded as an actor — see AccountActivityService.record's early
  // return. Does NOT hide activity ON this buyer's own account; it only
  // controls whether THIS buyer shows up in someone ELSE's insights.
  activityViewHistoryDisabled?: boolean;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const buyerSchema = new Schema<IBuyer>(
  {
    // Uniqueness for phone/email is enforced by PARTIAL indexes declared below
    // (not inline `unique + sparse`). A sparse unique index still collides on an
    // explicit `null`, so with email-only buyers (phone absent) and phone-only
    // buyers (email absent) coexisting, sparse is a footgun: it's what left a
    // legacy non-sparse phone_1 rejecting every email-only buyer after the first
    // with `E11000 { phone: null }`. The partial `$type: 'string'` filter indexes
    // only real string values, ignoring null/absent entirely.
    phone: { type: String, trim: true },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please enter a valid email address'],
    },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters long'],
      select: false
    },
    name: { type: String, trim: true, maxlength: 100 },
    nameChangedAt: { type: Date },
    avatarUrl: { type: String, trim: true },
    username: {
      type: String,
      unique: true,
      sparse: true, // pre-social buyers have no username yet
      index: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 20,
      match: [USERNAME_REGEX, 'Usernames are 3-20 characters: a-z, 0-9, _ and .']
    },
    bio: { type: String, trim: true, maxlength: 280 },
    city: { type: String, trim: true, maxlength: 100 },
    dmPrivacy: { type: String, enum: ['community', 'friends'], default: 'community' },
    notificationPrefs: {
      type: new Schema<NotificationPrefs>(
        {
          announcements: { type: Boolean, default: true },
          dms: { type: Boolean, default: true },
          mentions: { type: Boolean, default: true },
          social: { type: Boolean, default: true },
          reminders: { type: Boolean, default: true },
        },
        { _id: false }
      ),
      default: () => ({}),
    },
    usernameCustomizedAt: { type: Date },
    lastLoginAt: { type: Date },
    socialSuspendedAt: { type: Date, default: null },
    // Single-nested subdocument (like notificationPrefs above), deliberately
    // WITHOUT a default — a plain `{ type: {...}, coordinates: {...} }`
    // nested-path definition initializes to `{}` for every buyer, which is
    // the opposite of the "most buyers never opted in" invariant we need.
    // Giving it a real Schema keeps it `undefined` until PATCH /me/location
    // sets it, so the sparse 2dsphere index below actually excludes it.
    location: {
      type: new Schema<IBuyerLocation>(
        {
          type: { type: String, enum: ['Point'], required: true },
          coordinates: { type: [Number], required: true },
        },
        { _id: false }
      ),
      required: false,
    },
    locationUpdatedAt: { type: Date },
    activityViewHistoryDisabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Partial-unique on the two contact handles: index ONLY documents whose value
// is an actual string, so phone-absent (email-only) and email-absent
// (phone-only) buyers never collide on a null while real handles stay unique.
// Must match the live DB exactly (see scripts/fixBuyerContactIndexes.ts) or
// autoIndex logs an IndexOptionsConflict on every boot.
buyerSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
buyerSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });

// Sparse by nature (docs missing `location` are excluded automatically) —
// most buyers never opt in, and $geoNear can only run once this index exists.
buyerSchema.index({ location: '2dsphere' });

// Recency index for the activity feed's "just joined" source: joinCandidates()
// queries { createdAt: { $lt } } sorted newest-first. Must match the live DB
// (autoIndex) — see the partial-index note above.
buyerSchema.index({ createdAt: -1 });

// At least one contact handle must exist — phone and email are peers, but a
// buyer with neither has no identity to key tickets / tokens off.
buyerSchema.pre('validate', function (next) {
  if (!this.phone && !this.email) {
    next(new Error('A buyer needs a phone or email'));
    return;
  }
  next();
});

// Hash the password whenever it is set/changed.
buyerSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err as Error);
  }
});

buyerSchema.methods.comparePassword = async function (
  this: IBuyer,
  candidate: string
): Promise<boolean> {
  return bcrypt.compare(candidate, (this as any).password);
};

export const Buyer = model<IBuyer>('Buyer', buyerSchema);
