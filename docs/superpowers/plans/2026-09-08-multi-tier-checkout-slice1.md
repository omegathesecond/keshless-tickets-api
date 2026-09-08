# Multi-tier Checkout — Slice 1 (API cart core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one sale carry tickets from several tiers, by introducing a cart of
line items through the API's single mint choke point — without changing what a
one-line cart does today.

**Architecture:** A new `resolveCart()` owns every pre-payment decision (tier
existence, availability, method compatibility, per-account cap, service fee) and
returns a fully priced `ResolvedCart`. `sellTickets` takes those resolved lines
and mints across them. `TicketReservation` gains a `lines[]` array so one sale
can hold inventory on several tiers while keeping `saleId` unique. Only the two
synchronous rails (Keshless wallet, free-claim) are migrated in this slice; the
five async rails follow in slice 2.

**Tech Stack:** TypeScript, Express, Mongoose 7, Jest + ts-jest,
mongodb-memory-server via `src/__tests__/helpers/mongo`.

**Spec:** `docs/superpowers/specs/2026-09-08-multi-tier-checkout-design.md`

## Global Constraints

- **Equivalence is the acceptance bar.** A one-line cart must produce a sale,
  tickets, fee and `amountCharged` byte-identical to today's single-tier path.
  Every task that touches a sale path carries an equivalence test.
- **No backward-compatibility shims.** Old-shaped held reservations are drained
  by a migration script at cutover, not supported by dual-read code (spec §4).
- **No silent fallbacks.** A cart that cannot be satisfied throws with a message
  naming the tier. Never trim a cart to what happens to be available.
- **Path aliases** are configured in `jest.config.js`: use `@services/…`,
  `@models/…`, `@interfaces/…`, `@utils/…` in both source and tests.
- **Money helpers:** always `round2()` from `@utils/serviceFee.util` when summing
  currency. Never compare floats directly in assertions.
- **Run tests with `--runInBand`.** The suite races on a shared in-memory Mongo
  otherwise. The full suite has 3 known pre-existing failures (photo-gate 403s)
  unrelated to this work — compare against a baseline, and never pipe jest
  through `| tail` alone, which hides the exit code.

---

### Task 1: Cart interfaces and `resolveCart` — line validation

**Files:**
- Create: `src/interfaces/cart.interface.ts`
- Create: `src/services/cart.service.ts`
- Modify: `src/__tests__/helpers/fixtures.ts` (add a multi-tier seed — Tasks 1, 5 and 7 all need one)
- Test: `src/services/__tests__/cart.service.test.ts`

**Interfaces:**
- Consumes: `ITicketType` from `@interfaces/event.interface`; `Event` from `@models/event.model`; `assertCarrotTicketing` from `@utils/ticketingGuard.util`; `computeAvailable` from `@services/event.service` (it is exported from there, not from a util).
- Produces (test helper): `seedEventWithTiers(tiers: Array<Partial<ITicketType> & { name: string; price: number; quantity: number }>): Promise<{ eventId: string; vendorId: string; ticketTypeIds: string[]; event: IEvent }>` in `src/__tests__/helpers/fixtures.ts`.
- Produces:
  ```ts
  export interface CartLine { ticketTypeId: string; quantity: number; }
  export interface ResolvedLine {
    ticketTypeId: string;
    ticketType: ITicketType;   // the tier snapshot
    quantity: number;
    unitPrice: number;
    subtotal: number;          // unitPrice * quantity, round2
  }
  export interface ResolvedCart {
    event: IEvent;
    lines: ResolvedLine[];
    totalQuantity: number;
    faceTotal: number;
    serviceFeeAmount: number;
    absorbedServiceFeeAmount: number;
    amountCharged: number;
  }
  export function mergeCartLines(items: CartLine[]): CartLine[];
  export function resolveCart(input: {
    eventId: string;
    items: CartLine[];
    method: PaymentMethod;
    buyerId?: string;
    phone?: string;
  }): Promise<ResolvedCart>;
  ```

- [ ] **Step 1: Add the shared multi-tier fixture**

`seedPublishedEvent` in `src/__tests__/helpers/fixtures.ts` builds exactly ONE
tier. Tasks 1, 5 and 7 all need several, so add a sibling rather than growing
three near-identical local helpers. Append to that file:

```ts
/**
 * A PUBLISHED event with N ticket tiers, for the multi-tier cart paths.
 * `seedPublishedEvent` above stays the single-tier convenience wrapper the
 * older sale-path suites use.
 */
export async function seedEventWithTiers(
  tiers: Array<Record<string, unknown> & { name: string; price: number; quantity: number }>,
  opts: { vendorId?: mongoose.Types.ObjectId; maxTicketsPerAccount?: number; organizerAbsorbsServiceFee?: boolean } = {}
): Promise<{ eventId: string; vendorId: string; ticketTypeIds: string[]; event: any }> {
  const vendorId = opts.vendorId ?? new mongoose.Types.ObjectId();
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const event = await Event.create({
    vendorId,
    name: 'Multi-tier Test Event',
    venue: 'Test Venue',
    eventDate: futureDate,
    startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ...(opts.maxTicketsPerAccount ? { maxTicketsPerAccount: opts.maxTicketsPerAccount } : {}),
    ...(opts.organizerAbsorbsServiceFee ? { organizerAbsorbsServiceFee: true } : {}),
    ticketTypes: tiers.map((t) => ({ sold: 0, reserved: 0, ...t })),
  });

  return {
    eventId: event._id.toString(),
    vendorId: vendorId.toString(),
    ticketTypeIds: event.ticketTypes.map((tt) => tt._id!.toString()),
    event,
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `src/services/__tests__/cart.service.test.ts`:

```ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers } from '../../__tests__/helpers/fixtures';
import { resolveCart, mergeCartLines } from '@services/cart.service';
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';

beforeAll(async () => { await connectTestDb(); });
afterEach(async () => { await clearTestDb(); });
afterAll(async () => { await disconnectTestDb(); });

const TWO_TIERS = [
  { name: 'General', price: 100, quantity: 10 },
  { name: 'VIP', price: 250, quantity: 5 },
];

/** Local shim so the tests below read as `seedEvent()` / `seedEvent([...])`. */
async function seedEvent(tiers: Array<Record<string, unknown> & { name: string; price: number; quantity: number }> = TWO_TIERS) {
  const { event } = await seedEventWithTiers(tiers);
  return event;
}

describe('mergeCartLines', () => {
  it('merges duplicate ticketTypeIds so checks cannot be split', () => {
    expect(mergeCartLines([{ ticketTypeId: 'A', quantity: 1 }, { ticketTypeId: 'A', quantity: 2 }]))
      .toEqual([{ ticketTypeId: 'A', quantity: 3 }]);
  });

  it('rejects a non-positive quantity', () => {
    expect(() => mergeCartLines([{ ticketTypeId: 'A', quantity: 0 }])).toThrow(/quantity/i);
  });

  it('rejects an empty cart', () => {
    expect(() => mergeCartLines([])).toThrow(/at least one/i);
  });
});

describe('resolveCart — line validation', () => {
  it('prices a mixed cart across two tiers', async () => {
    const event = await seedEvent();
    const gen = event.ticketTypes[0]!._id!.toString();
    const vip = event.ticketTypes[1]!._id!.toString();

    const cart = await resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: gen, quantity: 2 }, { ticketTypeId: vip, quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    });

    expect(cart.lines).toHaveLength(2);
    expect(cart.totalQuantity).toBe(3);
    expect(cart.faceTotal).toBe(450); // 2*100 + 1*250
    expect(cart.lines[0]!.subtotal).toBe(200);
    expect(cart.lines[1]!.subtotal).toBe(250);
  });

  it('rejects a tier that does not belong to the event', async () => {
    const event = await seedEvent();
    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: new mongoose.Types.ObjectId().toString(), quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/ticket type not found/i);
  });

  it('rejects the WHOLE cart when one line is short, naming the tier', async () => {
    const event = await seedEvent([
      { name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 },
      { name: 'VIP', price: 250, quantity: 1, sold: 0, reserved: 0 },
    ]);
    const gen = event.ticketTypes[0]!._id!.toString();
    const vip = event.ticketTypes[1]!._id!.toString();

    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: gen, quantity: 2 }, { ticketTypeId: vip, quantity: 3 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/VIP/);
  });

  it('rejects a manually sold-out tier even with stock on hand', async () => {
    const event = await seedEvent([
      { name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0, isSoldOut: true },
    ]);
    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/sold out/i);
  });

  it('rejects an unpublished event', async () => {
    const event = await seedEvent();
    event.status = EventStatus.DRAFT;
    await event.save();
    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/not available|draft/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/services/__tests__/cart.service.test.ts --runInBand`
Expected: FAIL — `Cannot find module '@services/cart.service'`

- [ ] **Step 4: Write the interfaces**

Create `src/interfaces/cart.interface.ts`:

```ts
import type { IEvent, ITicketType } from '@interfaces/event.interface';

/** One tier + how many of it. The wire shape a client sends. */
export interface CartLine {
  ticketTypeId: string;
  quantity: number;
}

/** A CartLine after the tier has been found and priced. */
export interface ResolvedLine {
  ticketTypeId: string;
  ticketType: ITicketType;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

/** Everything the rails need to charge and mint. Produced only by resolveCart. */
export interface ResolvedCart {
  event: IEvent;
  lines: ResolvedLine[];
  totalQuantity: number;
  faceTotal: number;
  serviceFeeAmount: number;
  absorbedServiceFeeAmount: number;
  amountCharged: number;
}
```

- [ ] **Step 5: Write the minimal implementation**

Create `src/services/cart.service.ts`:

```ts
import { Event } from '@models/event.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod } from '@interfaces/ticket.interface';
import { assertCarrotTicketing } from '@utils/ticketingGuard.util';
import { computeAvailable } from '@services/event.service';
import { round2 } from '@utils/serviceFee.util';
import type { CartLine, ResolvedCart, ResolvedLine } from '@interfaces/cart.interface';

/**
 * Collapses duplicate tiers so every downstream check sees one line per tier.
 * Without this, `[{A,1},{A,2}]` would be validated as two independent 1- and
 * 2-ticket orders and could slip past a per-tier or per-account limit that a
 * single 3-ticket line would have failed.
 */
export function mergeCartLines(items: CartLine[]): CartLine[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('A cart must contain at least one ticket');
  }
  const byTier = new Map<string, number>();
  for (const item of items) {
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty < 1) {
      throw new Error('Each ticket line needs a whole quantity of at least 1');
    }
    byTier.set(item.ticketTypeId, (byTier.get(item.ticketTypeId) ?? 0) + qty);
  }
  return [...byTier].map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity }));
}

export async function resolveCart(input: {
  eventId: string;
  items: CartLine[];
  method: PaymentMethod;
  buyerId?: string;
  phone?: string;
}): Promise<ResolvedCart> {
  const items = mergeCartLines(input.items);

  const event = await Event.findOne({ _id: input.eventId, status: EventStatus.PUBLISHED });
  if (!event) throw new Error('Event not found or not available');
  assertCarrotTicketing(event);

  const lines: ResolvedLine[] = [];
  for (const item of items) {
    const ticketType = event.ticketTypes.find((tt) => tt._id?.toString() === item.ticketTypeId);
    if (!ticketType) throw new Error('Ticket type not found');

    if (ticketType.isSoldOut) {
      throw new Error(`${ticketType.name} is sold out`);
    }
    const availableNow = computeAvailable(ticketType);
    if (availableNow < item.quantity) {
      throw new Error(`Only ${availableNow} ${ticketType.name} tickets available`);
    }

    lines.push({
      ticketTypeId: item.ticketTypeId,
      ticketType,
      quantity: item.quantity,
      unitPrice: ticketType.price,
      subtotal: round2(ticketType.price * item.quantity),
    });
  }

  const faceTotal = round2(lines.reduce((sum, l) => sum + l.subtotal, 0));
  const totalQuantity = lines.reduce((sum, l) => sum + l.quantity, 0);

  // Fees arrive in Task 4; until then a cart is charged at face.
  return {
    event,
    lines,
    totalQuantity,
    faceTotal,
    serviceFeeAmount: 0,
    absorbedServiceFeeAmount: 0,
    amountCharged: faceTotal,
  };
}
```

`computeAvailable` is exported from `src/services/event.service.ts:96` (verified),
and `assertCarrotTicketing` from `src/utils/ticketingGuard.util.ts:3`. Importing
`computeAvailable` from `@services/event.service` into `cart.service` is a
service→service import; if that creates a cycle at runtime, move
`computeAvailable` into `src/utils/ticketAvailability.util.ts` and re-export it
from `event.service` so existing callers keep working.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/services/__tests__/cart.service.test.ts --runInBand`
Expected: PASS — 8 tests

- [ ] **Step 7: Commit**

```bash
git add src/interfaces/cart.interface.ts src/services/cart.service.ts src/services/__tests__/cart.service.test.ts src/__tests__/helpers/fixtures.ts
git commit -m "feat(cart): resolveCart validates and prices a multi-tier cart"
```

---

### Task 2: Per-account cap across the whole cart

**Files:**
- Modify: `src/services/cart.service.ts`
- Test: `src/services/__tests__/cart.service.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `resolveCart` from Task 1; `Ticket` from `@models/ticket.model`; `TicketStatus` from `@interfaces/ticket.interface`; `normalizePhone` from `@utils/phone.util`.
- Produces: no signature change — `resolveCart` gains a rejection case.

The rule (spec §3, decision 3): `alreadyOwned + sum(all cart lines) <= event.maxTicketsPerAccount`.
This is the bypass multi-tier creates — a per-line check on a 4-cap, 9-tier event
would permit 36 tickets.

- [ ] **Step 1: Write the failing test**

Append to `src/services/__tests__/cart.service.test.ts`:

```ts
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';

describe('resolveCart — per-account cap', () => {
  it('sums the WHOLE cart against the cap, not each line', async () => {
    const event = await seedEvent();
    event.maxTicketsPerAccount = 3;
    await event.save();
    const gen = event.ticketTypes[0]!._id!.toString();
    const vip = event.ticketTypes[1]!._id!.toString();
    const buyerId = new mongoose.Types.ObjectId().toString();

    // 2 + 2 = 4 > cap of 3, though NEITHER line alone exceeds it.
    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: gen, quantity: 2 }, { ticketTypeId: vip, quantity: 2 }],
      method: PaymentMethod.KESHLESS_WALLET,
      buyerId,
    })).rejects.toThrow(/limited to 3/i);
  });

  it('counts tickets the buyer already holds for this event', async () => {
    const event = await seedEvent();
    event.maxTicketsPerAccount = 2;
    await event.save();
    const gen = event.ticketTypes[0]!._id!.toString();
    const buyerId = new mongoose.Types.ObjectId();

    await Ticket.create({
      eventId: event._id, vendorId: event.vendorId, ticketType: 'General',
      price: 100, buyerId, status: TicketStatus.VALID,
    });

    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: gen, quantity: 2 }],
      method: PaymentMethod.KESHLESS_WALLET,
      buyerId: buyerId.toString(),
    })).rejects.toThrow(/already have 1|limited to 2/i);
  });

  it('ignores refunded and cancelled tickets when counting', async () => {
    const event = await seedEvent();
    event.maxTicketsPerAccount = 1;
    await event.save();
    const gen = event.ticketTypes[0]!._id!.toString();
    const buyerId = new mongoose.Types.ObjectId();

    await Ticket.create({
      eventId: event._id, vendorId: event.vendorId, ticketType: 'General',
      price: 100, buyerId, status: TicketStatus.REFUNDED,
    });

    const cart = await resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: gen, quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
      buyerId: buyerId.toString(),
    });
    expect(cart.totalQuantity).toBe(1);
  });

  it('skips the cap for an anonymous caller (POS walk-up)', async () => {
    const event = await seedEvent();
    event.maxTicketsPerAccount = 1;
    await event.save();
    const cart = await resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 5 }],
      method: PaymentMethod.CASH,
    });
    expect(cart.totalQuantity).toBe(5);
  });

  it('treats an absent cap as unlimited', async () => {
    const event = await seedEvent();
    const cart = await resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 9 }],
      method: PaymentMethod.KESHLESS_WALLET,
      buyerId: new mongoose.Types.ObjectId().toString(),
    });
    expect(cart.totalQuantity).toBe(9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/cart.service.test.ts -t "per-account cap" --runInBand`
Expected: FAIL — the first two tests resolve instead of rejecting.

- [ ] **Step 3: Write the implementation**

In `src/services/cart.service.ts`, add imports and a helper, then call it from
`resolveCart` after the per-line loop and before the fee section:

```ts
import { Ticket } from '@models/ticket.model';
import { TicketStatus } from '@interfaces/ticket.interface';
import { normalizePhone } from '@utils/phone.util';

/**
 * `maxTicketsPerAccount` is a per-EVENT cap, so it must be measured against the
 * buyer's existing tickets PLUS every line in this cart at once. Checking it
 * per line is the bypass multi-tier introduces: a 4-ticket cap on a 9-tier
 * event would otherwise permit 36.
 *
 * Skipped when the organizer set no cap, or when the caller has no identity to
 * bind (POS walk-up, wristband batch, reseller allocation) — an account rule
 * cannot constrain someone with no account and no phone.
 */
async function assertWithinAccountCap(p: {
  eventId: string;
  cap?: number;
  requested: number;
  buyerId?: string;
  phone?: string;
}): Promise<void> {
  const { cap } = p;
  if (typeof cap !== 'number' || cap <= 0) return;

  const identityClauses: Array<Record<string, unknown>> = [];
  if (p.buyerId) identityClauses.push({ buyerId: p.buyerId });
  const normPhone = p.phone ? normalizePhone(p.phone) : '';
  if (normPhone) identityClauses.push({ customerPhone: normPhone });
  if (identityClauses.length === 0) return;

  const held = await Ticket.countDocuments({
    eventId: p.eventId,
    status: { $nin: [TicketStatus.REFUNDED, TicketStatus.CANCELLED] },
    $or: identityClauses,
  });

  if (held + p.requested > cap) {
    throw new Error(
      cap === 1
        ? "You already have your ticket for this event — it's limited to one per person."
        : `This event is limited to ${cap} tickets per person; you already have ${held}.`
    );
  }
}
```

Call it in `resolveCart`, immediately after `totalQuantity` is computed:

```ts
  await assertWithinAccountCap({
    eventId: input.eventId,
    cap: event.maxTicketsPerAccount,
    requested: totalQuantity,
    buyerId: input.buyerId,
    phone: input.phone,
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/cart.service.test.ts --runInBand`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/cart.service.ts src/services/__tests__/cart.service.test.ts
git commit -m "feat(cart): enforce maxTicketsPerAccount across the whole cart"
```

---

### Task 3: Restricted-tier exclusivity and allocation mixing

**Files:**
- Modify: `src/services/cart.service.ts`
- Test: `src/services/__tests__/cart.service.test.ts` (append)

**Interfaces:**
- Consumes: `resolveCart`; `ITicketType.restrictToMethod`, `.isAllocation`, `.resellerId`.
- Produces: no signature change — two new rejection cases.

Two rules, both from the spec:
1. **Decision 2:** a tier carrying `restrictToMethod` may only be bought alone,
   and only on that method. A mixed cart has no payment method that satisfies
   every line, so it is rejected up front with a message naming the tier.
2. **Allocation attribution:** `resolveSaleResellerId` attributes a sale to the
   tier's owning reseller, but a sale stores ONE `resellerId`. Until slice 5
   handles multi-reseller attribution, a cart mixing tiers that resolve to
   different resellers (or mixing allocation with non-allocation) is rejected —
   silently picking one would misattribute money in the reseller ledger.

- [ ] **Step 1: Write the failing test**

Append to `src/services/__tests__/cart.service.test.ts`:

```ts
describe('resolveCart — restricted and allocation tiers', () => {
  it('rejects a restricted tier bought alongside another tier', async () => {
    const event = await seedEvent([
      { name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 },
      { name: 'DeltaPay Exclusive', price: 200, quantity: 10, sold: 0, reserved: 0,
        restrictToMethod: PaymentMethod.DELTAPAY },
    ]);
    const gen = event.ticketTypes[0]!._id!.toString();
    const excl = event.ticketTypes[1]!._id!.toString();

    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: gen, quantity: 1 }, { ticketTypeId: excl, quantity: 1 }],
      method: PaymentMethod.DELTAPAY,
    })).rejects.toThrow(/DeltaPay Exclusive.*on its own|only be bought on its own/i);
  });

  it('allows a restricted tier alone on its own method', async () => {
    const event = await seedEvent([
      { name: 'DeltaPay Exclusive', price: 200, quantity: 10, sold: 0, reserved: 0,
        restrictToMethod: PaymentMethod.DELTAPAY },
    ]);
    const cart = await resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 2 }],
      method: PaymentMethod.DELTAPAY,
    });
    expect(cart.faceTotal).toBe(400);
  });

  it('rejects a restricted tier on the wrong method', async () => {
    const event = await seedEvent([
      { name: 'DeltaPay Exclusive', price: 200, quantity: 10, sold: 0, reserved: 0,
        restrictToMethod: PaymentMethod.DELTAPAY },
    ]);
    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/can only be bought with/i);
  });

  it('rejects a cart mixing allocation and non-allocation tiers', async () => {
    const resellerId = new mongoose.Types.ObjectId();
    const event = await seedEvent([
      { name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 },
      { name: 'Reseller Block', price: 100, quantity: 10, sold: 0, reserved: 0,
        isAllocation: true, resellerId },
    ]);
    const gen = event.ticketTypes[0]!._id!.toString();
    const alloc = event.ticketTypes[1]!._id!.toString();

    await expect(resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: gen, quantity: 1 }, { ticketTypeId: alloc, quantity: 1 }],
      method: PaymentMethod.KESHLESS_WALLET,
    })).rejects.toThrow(/allocation/i);
  });

  it('allows several allocation tiers owned by the SAME reseller', async () => {
    const resellerId = new mongoose.Types.ObjectId();
    const event = await seedEvent([
      { name: 'Block A', price: 100, quantity: 10, sold: 0, reserved: 0, isAllocation: true, resellerId },
      { name: 'Block B', price: 150, quantity: 10, sold: 0, reserved: 0, isAllocation: true, resellerId },
    ]);
    const cart = await resolveCart({
      eventId: event._id.toString(),
      items: [
        { ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 1 },
        { ticketTypeId: event.ticketTypes[1]!._id!.toString(), quantity: 1 },
      ],
      method: PaymentMethod.KESHLESS_WALLET,
    });
    expect(cart.faceTotal).toBe(250);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/cart.service.test.ts -t "restricted and allocation" --runInBand`
Expected: FAIL — the three rejection cases resolve instead of throwing.

- [ ] **Step 3: Write the implementation**

Add to `src/services/cart.service.ts`, called from `resolveCart` right after the
per-line loop builds `lines`:

```ts
/**
 * A tier with `restrictToMethod` is EXCLUSIVE: it may only be bought on its own
 * method, and never alongside another tier. Offering "only the methods valid
 * for every line" instead would almost always leave an empty method list — a
 * cart the buyer cannot pay for, with no explanation of why. Rejecting here,
 * naming the tier, is the honest failure.
 */
function assertMethodCompatible(lines: ResolvedLine[], method: PaymentMethod): void {
  const restricted = lines.filter((l) => l.ticketType.restrictToMethod);
  if (restricted.length === 0) return;

  if (lines.length > 1) {
    throw new Error(
      `${restricted[0]!.ticketType.name} can only be bought on its own, not with other ticket types`
    );
  }
  const only = restricted[0]!;
  if (only.ticketType.restrictToMethod !== method) {
    throw new Error(`This ticket can only be bought with ${only.ticketType.restrictToMethod}`);
  }
}

/**
 * A TicketSale stores ONE resellerId, but allocation tiers are attributed to
 * the tier's owning reseller (see resolveSaleResellerId). A cart spanning two
 * different owners therefore has no correct value to store, and picking one
 * would misattribute money in the reseller ledger. Rejected until slice 5
 * models per-line attribution.
 */
function assertSingleAttribution(lines: ResolvedLine[]): void {
  const owners = new Set(
    lines.map((l) => (l.ticketType.isAllocation ? String(l.ticketType.resellerId ?? 'MISSING') : 'none'))
  );
  if (owners.size > 1) {
    throw new Error('Allocation tickets must be bought on their own, not mixed with other ticket types');
  }
  if (owners.has('MISSING')) {
    throw new Error('Allocation tier is missing resellerId — cannot attribute sale');
  }
}
```

Wire both in, after the loop that fills `lines`:

```ts
  assertMethodCompatible(lines, input.method);
  assertSingleAttribution(lines);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/cart.service.test.ts --runInBand`
Expected: PASS — 18 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/cart.service.ts src/services/__tests__/cart.service.test.ts
git commit -m "feat(cart): restricted tiers are exclusive; reject mixed allocation attribution"
```

---

### Task 4: Per-line service fee

**Files:**
- Modify: `src/services/cart.service.ts`
- Test: `src/services/__tests__/cart.service.test.ts` (append)

**Interfaces:**
- Consumes: `computeServiceFee(subtotal, quantity, method, cfg, opts)` and `round2` from `@utils/serviceFee.util`; `PaymentConfigService.get()` from `@services/paymentConfig.service`.
- Produces: `resolveCart` now returns real `serviceFeeAmount`, `absorbedServiceFeeAmount`, `amountCharged`.

Spec §3, decision 1: the fee is **per ticket**, and `waiveServiceFee` is
**per tier**, so the fee is computed once per line with that line's own
`subtotal`, `quantity` and `waiveServiceFee`, then summed. This is the only
arrangement where a basket costs exactly what buying each tier separately would.

- [ ] **Step 1: Write the failing test**

Append to `src/services/__tests__/cart.service.test.ts`:

```ts
import { PaymentConfigService } from '@services/paymentConfig.service';

describe('resolveCart — service fee', () => {
  it('charges a mixed waived/non-waived cart the SUM of the two bought separately', async () => {
    const event = await seedEvent([
      { name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 },
      { name: 'Waived', price: 100, quantity: 10, sold: 0, reserved: 0, waiveServiceFee: true },
    ]);
    const gen = event.ticketTypes[0]!._id!.toString();
    const waived = event.ticketTypes[1]!._id!.toString();
    const method = PaymentMethod.KESHLESS_WALLET;
    const base = { eventId: event._id.toString(), method };

    const genOnly = await resolveCart({ ...base, items: [{ ticketTypeId: gen, quantity: 2 }] });
    const waivedOnly = await resolveCart({ ...base, items: [{ ticketTypeId: waived, quantity: 3 }] });
    const together = await resolveCart({
      ...base,
      items: [{ ticketTypeId: gen, quantity: 2 }, { ticketTypeId: waived, quantity: 3 }],
    });

    expect(waivedOnly.serviceFeeAmount).toBe(0);
    expect(together.serviceFeeAmount).toBe(round2(genOnly.serviceFeeAmount + waivedOnly.serviceFeeAmount));
    expect(together.serviceFeeAmount).toBe(genOnly.serviceFeeAmount);
    expect(together.amountCharged).toBe(round2(together.faceTotal + together.serviceFeeAmount));
  });

  it('routes the fee to the organizer when the event absorbs it', async () => {
    const event = await seedEvent();
    event.organizerAbsorbsServiceFee = true;
    await event.save();

    const cart = await resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 2 }],
      method: PaymentMethod.KESHLESS_WALLET,
    });

    expect(cart.serviceFeeAmount).toBe(0);
    expect(cart.absorbedServiceFeeAmount).toBeGreaterThan(0);
    expect(cart.amountCharged).toBe(cart.faceTotal); // buyer pays face
  });

  it('charges no fee on a free line', async () => {
    const event = await seedEvent([{ name: 'Free', price: 0, quantity: 10, sold: 0, reserved: 0 }]);
    const cart = await resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 2 }],
      method: PaymentMethod.CASH,
    });
    expect(cart.serviceFeeAmount).toBe(0);
    expect(cart.amountCharged).toBe(0);
  });

  it('matches the single-tier path exactly for a one-line cart (equivalence)', async () => {
    const event = await seedEvent();
    const gen = event.ticketTypes[0]!._id!.toString();
    const cfg = await PaymentConfigService.get();
    const { computeServiceFee } = await import('@utils/serviceFee.util');
    const expected = computeServiceFee(200, 2, PaymentMethod.KESHLESS_WALLET, cfg, {
      waiveServiceFee: undefined, absorbedByOrganizer: undefined,
    });

    const cart = await resolveCart({
      eventId: event._id.toString(),
      items: [{ ticketTypeId: gen, quantity: 2 }],
      method: PaymentMethod.KESHLESS_WALLET,
    });

    expect(cart.serviceFeeAmount).toBe(expected.serviceFeeAmount);
    expect(cart.amountCharged).toBe(expected.amountCharged);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/cart.service.test.ts -t "service fee" --runInBand`
Expected: FAIL — every fee is 0 because Task 1 stubbed it.

- [ ] **Step 3: Write the implementation**

In `src/services/cart.service.ts`, add imports and replace the stubbed return:

```ts
import { computeServiceFee } from '@utils/serviceFee.util';
import { PaymentConfigService } from '@services/paymentConfig.service';
```

```ts
  // Fee is PER TICKET and `waiveServiceFee` is PER TIER, so it is computed once
  // per line with that line's own subtotal/quantity/waiver and summed. This is
  // what makes a basket cost exactly what buying each tier separately costs —
  // no buyer is better or worse off for using the cart.
  const feeCfg = await PaymentConfigService.get();
  let serviceFeeAmount = 0;
  let absorbedServiceFeeAmount = 0;
  for (const line of lines) {
    const fee = computeServiceFee(line.subtotal, line.quantity, input.method, feeCfg, {
      waiveServiceFee: line.ticketType.waiveServiceFee,
      absorbedByOrganizer: event.organizerAbsorbsServiceFee,
    });
    serviceFeeAmount = round2(serviceFeeAmount + fee.serviceFeeAmount);
    absorbedServiceFeeAmount = round2(absorbedServiceFeeAmount + fee.absorbedServiceFeeAmount);
  }

  return {
    event,
    lines,
    totalQuantity,
    faceTotal,
    serviceFeeAmount,
    absorbedServiceFeeAmount,
    amountCharged: round2(faceTotal + serviceFeeAmount),
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/cart.service.test.ts --runInBand`
Expected: PASS — 22 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/cart.service.ts src/services/__tests__/cart.service.test.ts
git commit -m "feat(cart): compute the service fee per line and sum it"
```

---

### Task 5: `sellTickets` mints across lines

**Files:**
- Modify: `src/services/ticket.service.ts` (`SellTicketsParams`, `sellTickets`, both the transactional and no-transaction branches)
- Modify: `src/controllers/tickets.controller.ts:879` (POS caller — pass a one-line array)
- Modify: `src/services/resellerSale.service.ts:132` (pass a one-line array)
- Test: `src/services/__tests__/sellTickets.multiline.test.ts`

**Interfaces:**
- Consumes: `ResolvedLine` from `@interfaces/cart.interface`.
- Produces: `SellTicketsParams.lines: Array<{ ticketTypeId: string; ticketType: ITicketType; quantity: number }>` **replaces** `ticketTypeId` and `quantity`. Returns the same `{ sale, tickets, paymentMessage }`.

`sellTickets` is documented as *"the SINGLE mint choke point every sale path
funnels through"*, so this is the only place minting changes.

Note the existing structure: there is a transactional path AND a duplicated
"no transaction" fallback that re-mints when Mongo reports
`Transaction numbers are only allowed on a replica set`. **Both** loops must
become line-aware, or the fallback silently mints the wrong tiers.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/sellTickets.multiline.test.ts`:

```ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketService } from '@services/ticket.service';
import { Event } from '@models/event.model';
import { Ticket } from '@models/ticket.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, SalesChannel } from '@interfaces/ticket.interface';

beforeAll(async () => { await connectTestDb(); });
afterEach(async () => { await clearTestDb(); });
afterAll(async () => { await disconnectTestDb(); });

async function seedEvent() {
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'Test Event', venue: 'Test Venue',
    eventDate: futureDate, startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 2 * 60 * 60 * 1000),
    status: EventStatus.PUBLISHED,
    ticketTypes: [
      { name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 },
      { name: 'VIP', price: 250, quantity: 5, sold: 0, reserved: 0 },
    ],
  });
}

describe('sellTickets — multi-line', () => {
  it('mints the right tier and price for each line, under one sale', async () => {
    const event = await seedEvent();
    const [gen, vip] = event.ticketTypes;

    const { sale, tickets } = await TicketService.sellTickets({
      eventId: event._id.toString(),
      vendorId: event.vendorId!.toString(),
      lines: [
        { ticketTypeId: gen!._id!.toString(), ticketType: gen!, quantity: 2 },
        { ticketTypeId: vip!._id!.toString(), ticketType: vip!, quantity: 1 },
      ],
      customerName: 'Test Buyer',
      paymentMethod: PaymentMethod.CASH,
      soldBy: event.vendorId!.toString(),
      soldByType: 'vendor',
      channel: SalesChannel.ONLINE,
    });

    expect(tickets).toHaveLength(3);
    expect(sale.quantity).toBe(3);
    expect(sale.totalAmount).toBe(450);
    expect(sale.ticketIds).toHaveLength(3);

    const minted = await Ticket.find({ saleId: sale._id }).sort({ price: 1 });
    expect(minted.map((t) => t.ticketType)).toEqual(['General', 'General', 'VIP']);
    expect(minted.map((t) => t.price)).toEqual([100, 100, 250]);
  });

  it('is byte-identical to the old single-tier path for a one-line cart', async () => {
    const event = await seedEvent();
    const gen = event.ticketTypes[0]!;

    const { sale, tickets } = await TicketService.sellTickets({
      eventId: event._id.toString(),
      vendorId: event.vendorId!.toString(),
      lines: [{ ticketTypeId: gen._id!.toString(), ticketType: gen, quantity: 2 }],
      customerName: 'Test Buyer',
      paymentMethod: PaymentMethod.CASH,
      soldBy: event.vendorId!.toString(),
      soldByType: 'vendor',
      channel: SalesChannel.ONLINE,
    });

    expect(tickets).toHaveLength(2);
    expect(sale.quantity).toBe(2);
    expect(sale.totalAmount).toBe(200);
    expect(tickets.every((t) => t.ticketType === 'General')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/sellTickets.multiline.test.ts --runInBand`
Expected: FAIL — TypeScript rejects `lines` (not on `SellTicketsParams`).

- [ ] **Step 3: Change the params type**

In `src/services/ticket.service.ts`, in `SellTicketsParams`, **delete**:

```ts
  ticketTypeId: string;
  quantity: number;
```

and **add**:

```ts
  /** One entry per tier in this sale. A single-tier sale is a one-element
   *  array — the shape every caller used before multi-tier checkout. */
  lines: Array<{ ticketTypeId: string; ticketType: ITicketType; quantity: number }>;
```

Import `ITicketType` from `@interfaces/event.interface` if not already imported.

- [ ] **Step 4: Rewrite the mint section**

In `sellTickets`, replace the destructure of `ticketTypeId, quantity` with
`lines`, and replace the availability + total computation:

```ts
      const quantity = params.lines.reduce((sum, l) => sum + l.quantity, 0);
      // Availability is re-checked per line even though resolveCart already
      // did: this is the choke point every path funnels through, including
      // POS and reseller callers that never went near resolveCart.
      for (const line of params.lines) {
        const check = await EventService.checkTicketAvailability(
          eventId, line.ticketTypeId, line.quantity, paymentMethod,
          { buyerId: params.buyerId, phone: params.customerPhone }
        );
        if (!check.available) throw new Error(check.message || 'Tickets not available');
      }
      const totalAmount = round2(
        params.lines.reduce((sum, l) => sum + l.ticketType.price * l.quantity, 0)
      );
```

Replace the charge description (it named a single tier):

```ts
        description: params.lines.length === 1
          ? `Carrot Tickets - ${params.lines[0]!.ticketType.name} x${params.lines[0]!.quantity}`
          : `Carrot Tickets - ${quantity} tickets (${params.lines.length} types)`,
```

Replace **both** mint loops (the transactional one and the no-transaction
fallback) with a nested loop, and take `resolveSaleResellerId` / `isAllocation`
from the first line (Task 3 guarantees every line shares one attribution):

```ts
      const attributionTier = params.lines[0]!.ticketType;
      const saleResellerId = resolveSaleResellerId(
        attributionTier, params.resellerId ? String(params.resellerId) : undefined
      );
      const resellerAttribution = {
        ...(saleResellerId ? { resellerId: saleResellerId } : {}),
        ...(params.hubId ? { hubId: params.hubId } : {}),
        ...(attributionTier.isAllocation ? { isAllocation: true } : {}),
      };

      const tickets: ITicket[] = [];
      for (const line of params.lines) {
        for (let i = 0; i < line.quantity; i++) {
          const ticket = this.buildTicket({
            eventId, vendorId,
            ticketType: line.ticketType.name,
            price: line.ticketType.price,
            customerName, customerPhone, customerEmail, buyerId,
            currency: displayCurrency,
          });
          await ticket.save(session ? { session } : undefined);
          tickets.push(ticket);
        }
      }
```

Apply the identical nested loop in the no-transaction fallback branch (the one
building `ticketsWithoutSession`). Do not leave it minting `ticketTypeData`.

- [ ] **Step 5: Update the two direct callers**

`src/controllers/tickets.controller.ts:879` and
`src/services/resellerSale.service.ts:132` currently pass `ticketTypeId` +
`quantity`. Each must first look up its tier on the event and pass a one-element
`lines` array:

Both callers already have the event in scope (they load it to validate before
selling). Immediately before each `TicketService.sellTickets({ ... })` call, add
the tier lookup:

```ts
  const tier = event.ticketTypes.find((tt) => tt._id?.toString() === ticketTypeId);
  if (!tier) throw new Error('Ticket type not found');
```

Then, inside the existing `sellTickets({ ... })` argument object, delete the two
lines

```ts
        ticketTypeId,
        quantity,
```

and put in their place

```ts
        lines: [{ ticketTypeId, ticketType: tier, quantity }],
```

Leave every other property of those two call sites untouched — `soldBy`,
`soldByType`, `channel`, `resellerId`, `hubId`, `resellerCommissionPercent` and
the fee fields all keep their current values. If a caller does not already have
the event loaded, load it with
`const event = await Event.findById(eventId);` and throw
`new Error('Event not found')` when it is missing, rather than passing a tier
you could not verify.

- [ ] **Step 6: Run the tests**

```bash
npx tsc --noEmit
npx jest src/services/__tests__/sellTickets.multiline.test.ts --runInBand
npx jest src/services/__tests__/sellTickets.pending.test.ts src/services/__tests__/sellTicketsChokePointGuard.test.ts src/services/__tests__/ticket.deltapay.allocation.test.ts --runInBand
```
Expected: typecheck clean; all suites PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/ticket.service.ts src/controllers/tickets.controller.ts src/services/resellerSale.service.ts src/services/__tests__/sellTickets.multiline.test.ts
git commit -m "feat(tickets): sellTickets mints across cart lines"
```

---

### Task 6: `TicketReservation.lines` and the drain migration

**Files:**
- Modify: `src/models/ticketReservation.model.ts`
- Modify: `src/services/reservation.service.ts`
- Modify: `src/services/ticket.service.ts` — the 5 `ReservationService.reserve({...})` call sites (~1283, 1443, 1598, 2379, and the YeboPay one; find with `grep -n "ReservationService.reserve"`)
- Create: `src/scripts/releaseHeldReservations.ts`
- Test: `src/services/__tests__/reservation.multiline.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ReservationService.reserve({ eventId, lines: Array<{ticketTypeId, quantity}>, saleId, ttlMs })`. `confirm(saleId)` and `release(saleId)` keep their signatures — they already key off `saleId` alone, which is why `saleId` stays `unique`.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/reservation.multiline.test.ts`:

```ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { ReservationService } from '@services/reservation.service';
import { Event } from '@models/event.model';
import { TicketSale } from '@models/ticketSale.model';
import { EventStatus } from '@interfaces/event.interface';
import { PaymentMethod, PaymentStatus } from '@interfaces/ticket.interface';

beforeAll(async () => { await connectTestDb(); });
afterEach(async () => { await clearTestDb(); });
afterAll(async () => { await disconnectTestDb(); });

async function seed() {
  const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const event = await Event.create({
    vendorId: new mongoose.Types.ObjectId(),
    name: 'E', venue: 'V', eventDate: futureDate, startTime: futureDate,
    endTime: new Date(futureDate.getTime() + 7200000), status: EventStatus.PUBLISHED,
    ticketTypes: [
      { name: 'General', price: 100, quantity: 10, sold: 0, reserved: 0 },
      { name: 'VIP', price: 250, quantity: 5, sold: 0, reserved: 0 },
    ],
  });
  const sale = await TicketSale.create({
    eventId: event._id, vendorId: event.vendorId, ticketIds: [], quantity: 3,
    totalAmount: 450, paymentMethod: PaymentMethod.YOCO, paymentStatus: PaymentStatus.PENDING,
    soldBy: event.vendorId, soldByType: 'Vendor',
  });
  return { event, sale };
}

describe('ReservationService — multi-line holds', () => {
  it('holds inventory on every tier in one reservation', async () => {
    const { event, sale } = await seed();
    await ReservationService.reserve({
      eventId: event._id.toString(),
      lines: [
        { ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 2 },
        { ticketTypeId: event.ticketTypes[1]!._id!.toString(), quantity: 1 },
      ],
      saleId: sale._id.toString(),
      ttlMs: 60_000,
    });

    const after = await Event.findById(event._id);
    expect(after!.ticketTypes[0]!.reserved).toBe(2);
    expect(after!.ticketTypes[1]!.reserved).toBe(1);
  });

  it('releases every line', async () => {
    const { event, sale } = await seed();
    await ReservationService.reserve({
      eventId: event._id.toString(),
      lines: [
        { ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 2 },
        { ticketTypeId: event.ticketTypes[1]!._id!.toString(), quantity: 1 },
      ],
      saleId: sale._id.toString(), ttlMs: 60_000,
    });
    await ReservationService.release(sale._id.toString());

    const after = await Event.findById(event._id);
    expect(after!.ticketTypes[0]!.reserved).toBe(0);
    expect(after!.ticketTypes[1]!.reserved).toBe(0);
  });

  it('confirms every line', async () => {
    const { event, sale } = await seed();
    await ReservationService.reserve({
      eventId: event._id.toString(),
      lines: [{ ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 2 }],
      saleId: sale._id.toString(), ttlMs: 60_000,
    });
    await ReservationService.confirm(sale._id.toString());

    const after = await Event.findById(event._id);
    expect(after!.ticketTypes[0]!.reserved).toBe(0);
  });

  it('sweeps an expired multi-line hold, releasing all tiers', async () => {
    const { event, sale } = await seed();
    await ReservationService.reserve({
      eventId: event._id.toString(),
      lines: [
        { ticketTypeId: event.ticketTypes[0]!._id!.toString(), quantity: 2 },
        { ticketTypeId: event.ticketTypes[1]!._id!.toString(), quantity: 1 },
      ],
      saleId: sale._id.toString(), ttlMs: -1, // already expired
    });

    const n = await ReservationService.sweepExpired();
    expect(n).toBe(1);
    const after = await Event.findById(event._id);
    expect(after!.ticketTypes[0]!.reserved).toBe(0);
    expect(after!.ticketTypes[1]!.reserved).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/reservation.multiline.test.ts --runInBand`
Expected: FAIL — `reserve` does not accept `lines`.

- [ ] **Step 3: Change the model**

In `src/models/ticketReservation.model.ts`, replace `ticketTypeId` and
`quantity` with a `lines` array. Keep `saleId` **unique** — it is what makes
`confirm`/`release` idempotent:

```ts
export interface IReservationLine { ticketTypeId: string; quantity: number; }

export interface ITicketReservation extends mongoose.Document {
  eventId: mongoose.Types.ObjectId;
  lines: IReservationLine[];
  saleId: mongoose.Types.ObjectId;
  expiresAt: Date;
  status: 'held' | 'confirmed' | 'released';
}

const lineSchema = new Schema<IReservationLine>({
  ticketTypeId: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
}, { _id: false });

const schema = new Schema<ITicketReservation>({
  eventId: { type: Schema.Types.ObjectId, ref: 'Event', required: true, index: true },
  lines: { type: [lineSchema], required: true, validate: [(v: unknown[]) => v.length > 0, 'at least one line'] },
  saleId: { type: Schema.Types.ObjectId, ref: 'TicketSale', required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['held', 'confirmed', 'released'], default: 'held', index: true },
}, { timestamps: true });
```

- [ ] **Step 4: Loop in the service**

In `src/services/reservation.service.ts`, change `reserve` to take `lines` and
adjust each; make `confirm`, `release` and `sweepExpired` iterate `r.lines`:

```ts
  static async reserve(p: {
    eventId: string;
    lines: Array<{ ticketTypeId: string; quantity: number }>;
    saleId: string;
    ttlMs: number;
  }): Promise<{ reservationId: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + p.ttlMs);
    for (const line of p.lines) {
      await adjustReserved(p.eventId, line.ticketTypeId, +line.quantity);
    }
    const r = await TicketReservation.create({
      eventId: p.eventId, lines: p.lines, saleId: p.saleId, expiresAt, status: 'held',
    });
    return { reservationId: r._id.toString(), expiresAt };
  }
```

In `confirm`, `release` and the `sweepExpired` loop, replace the single
`adjustReserved(r.eventId, r.ticketTypeId, -r.quantity)` with:

```ts
    for (const line of r.lines) {
      await adjustReserved(r.eventId, line.ticketTypeId, -line.quantity);
    }
```

- [ ] **Step 5: Update the 5 reserve call sites**

Find them with `grep -n "ReservationService.reserve" src/services/ticket.service.ts`.
Each currently passes `ticketTypeId` + `quantity`; change each to:

```ts
      lines: [{ ticketTypeId, quantity }],
```

(These rails are migrated to real carts in slice 2; a one-element array here is
behaviour-preserving.)

- [ ] **Step 6: Write the drain migration**

Create `src/scripts/releaseHeldReservations.ts`:

```ts
/**
 * Cutover drain for the TicketReservation `lines[]` change.
 *
 * Run ONCE, immediately BEFORE deploying the slice-1 revision. Releases every
 * still-held reservation through the pre-change field shape, restoring each
 * tier's `reserved` count, so the new code never meets an old-shaped document
 * and no dual-read compatibility path is needed.
 *
 * Confirmed/released rows are inert history and are left alone.
 *
 * Usage:
 *   MONGODB_URI='...' npx ts-node -r tsconfig-paths/register src/scripts/releaseHeldReservations.ts
 */
import mongoose from 'mongoose';
import { Event } from '@models/event.model';

async function main(): Promise<void> {
  const uri = process.env['MONGODB_URI'];
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri);

  const coll = mongoose.connection.db!.collection('ticketreservations');
  const held = await coll.find({ status: 'held' }).toArray();
  console.log(`held reservations to drain: ${held.length}`);

  let drained = 0;
  for (const r of held) {
    // Old shape only — this script runs before the new writer exists.
    const legacyLines = Array.isArray(r['lines'])
      ? (r['lines'] as Array<{ ticketTypeId: string; quantity: number }>)
      : [{ ticketTypeId: String(r['ticketTypeId']), quantity: Number(r['quantity']) }];

    const event = await Event.findById(r['eventId']);
    if (event) {
      for (const line of legacyLines) {
        const tt = event.ticketTypes.find((t) => t._id?.toString() === line.ticketTypeId);
        if (tt) tt.reserved = Math.max(0, (tt.reserved || 0) - line.quantity);
      }
      await event.save();
    }
    await coll.updateOne({ _id: r['_id'] }, { $set: { status: 'released' } });
    drained++;
  }

  console.log(`drained: ${drained}`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('drain failed:', e); process.exit(1); });
```

- [ ] **Step 7: Run the tests**

```bash
npx tsc --noEmit
npx jest src/services/__tests__/reservation.multiline.test.ts src/services/__tests__/reservation.service.test.ts src/services/__tests__/reservation.sweep.yoco.test.ts --runInBand
```
Expected: typecheck clean; all PASS. `reservation.service.test.ts` will need its
`reserve(...)` calls updated to the `lines` shape — that is expected and part of
this task.

- [ ] **Step 8: Commit**

```bash
git add src/models/ticketReservation.model.ts src/services/reservation.service.ts src/services/ticket.service.ts src/scripts/releaseHeldReservations.ts src/services/__tests__/
git commit -m "feat(reservations): hold several tiers under one sale via lines[]"
```

---

### Task 7: Migrate the two synchronous rails to carts

**Files:**
- Modify: `src/services/ticket.service.ts` — `purchaseForCustomer` (~821), `claimFreeTicket` (~985)
- Modify: `src/controllers/public.controller.ts` — `purchaseTickets` (~786), `claimFreeTicket`
- Modify: `src/validators/tickets.validator.ts` — `publicPurchaseSchema`, `freeClaimSchema`
- Test: `src/services/__tests__/claimFreeTicket.multiline.test.ts`

**Interfaces:**
- Consumes: `resolveCart` (Tasks 1–4), `sellTickets({ lines })` (Task 5), `seedEventWithTiers` (Task 1).
- Produces: `TicketService.purchaseForCustomer` and `TicketService.claimFreeTicket` take `items: CartLine[]` in place of `ticketTypeId` + `quantity`. `POST /api/public/purchase` and `POST /api/public/purchase/free` accept `{ eventId, items: [{ticketTypeId, quantity}], ... }`.

Tests live at the **service** layer, matching
`claimFreeTicket.security.test.ts` — that is where the cart logic actually is,
and it avoids standing up buyer-auth plumbing to prove tier arithmetic. The
free-claim path charges through the CASH processor, so it needs no payment
gateway; `purchaseForCustomer` is covered by the equivalence assertions in
Task 5 plus the `resolveCart` suites.

- [ ] **Step 1: Write the failing test**

Create `src/services/__tests__/claimFreeTicket.multiline.test.ts`:

```ts
import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers } from '../../__tests__/helpers/fixtures';
import { TicketService } from '@services/ticket.service';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { EmailService } from '@services/email.service';
import { SmsService } from '@services/sms.service';
import { Ticket } from '@models/ticket.model';
import { TicketSale } from '@models/ticketSale.model';

beforeAll(connectTestDb);
beforeEach(async () => {
  await PaymentConfigService.update({ platformFeePercent: 0 });
  jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
  jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
});
afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
afterAll(disconnectTestDb);

describe('claimFreeTicket — multi-tier', () => {
  it('claims two free tiers in one request, minting both', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'Free GA', price: 0, quantity: 10 },
      { name: 'Free Kids', price: 0, quantity: 10 },
    ]);
    const buyerId = new mongoose.Types.ObjectId().toString();

    const result = await TicketService.claimFreeTicket({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      customerEmail: 'buyer@example.com',
      buyerId,
    });

    expect(result.quantity).toBe(3);
    expect(result.totalAmount).toBe(0);

    const sale = await TicketSale.findOne({ eventId });
    const minted = await Ticket.find({ saleId: sale!._id });
    expect(minted).toHaveLength(3);
    expect(minted.filter((t) => t.ticketType === 'Free GA')).toHaveLength(2);
    expect(minted.filter((t) => t.ticketType === 'Free Kids')).toHaveLength(1);
  });

  it('REJECTS a cart where any line is paid, naming that tier', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'Free GA', price: 0, quantity: 10 },
      { name: 'Paid VIP', price: 250, quantity: 10 },
    ]);

    await expect(TicketService.claimFreeTicket({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 1 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      customerEmail: 'attacker@example.com',
      buyerId: new mongoose.Types.ObjectId().toString(),
    })).rejects.toThrow(/Paid VIP.*not free|not free/i);

    // Nothing was minted as a side effect.
    expect(await TicketSale.countDocuments({ eventId })).toBe(0);
    expect(await Ticket.countDocuments({ eventId })).toBe(0);
  });

  it('still mints a single free tier exactly as before (equivalence)', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers([
      { name: 'Free GA', price: 0, quantity: 10 },
    ]);

    const result = await TicketService.claimFreeTicket({
      eventId,
      items: [{ ticketTypeId: ticketTypeIds[0]!, quantity: 2 }],
      customerEmail: 'buyer@example.com',
      buyerId: new mongoose.Types.ObjectId().toString(),
    });

    expect(result.quantity).toBe(2);
    expect(result.totalAmount).toBe(0);
    const sale = await TicketSale.findOne({ eventId });
    expect(sale!.totalAmount).toBe(0);
    expect(sale!.serviceFeeAmount).toBe(0);
    expect(sale!.quantity).toBe(2);
  });

  it('enforces the per-account cap across the whole free cart', async () => {
    const { eventId, ticketTypeIds } = await seedEventWithTiers(
      [
        { name: 'Free GA', price: 0, quantity: 10 },
        { name: 'Free Kids', price: 0, quantity: 10 },
      ],
      { maxTicketsPerAccount: 2 }
    );

    await expect(TicketService.claimFreeTicket({
      eventId,
      items: [
        { ticketTypeId: ticketTypeIds[0]!, quantity: 2 },
        { ticketTypeId: ticketTypeIds[1]!, quantity: 1 },
      ],
      customerEmail: 'buyer@example.com',
      buyerId: new mongoose.Types.ObjectId().toString(),
    })).rejects.toThrow(/limited to 2/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/claimFreeTicket.multiline.test.ts --runInBand`
Expected: FAIL — TypeScript rejects `items` (`claimFreeTicket` still takes
`ticketTypeId` + `quantity`).

- [ ] **Step 3: Update the validators**

In `src/validators/tickets.validator.ts`, replace `ticketTypeId` + `quantity` in
`publicPurchaseSchema` and `freeClaimSchema` with:

```ts
  items: Joi.array()
    .items(Joi.object({
      ticketTypeId: Joi.string().hex().length(24).required(),
      quantity: Joi.number().integer().min(1).max(50).required(),
    }))
    .min(1)
    .max(20)
    .required(),
```

- [ ] **Step 4: Rewrite `purchaseForCustomer` over the cart**

Replace its `ticketTypeId`/`quantity` params with `items: CartLine[]`, delete the
hand-rolled tier lookup, sold-out check, `restrictToMethod` check and fee
computation (all now inside `resolveCart`), and keep the PIN rule on the cart's
face total:

```ts
    const cart = await resolveCart({
      eventId, items, method: PaymentMethod.KESHLESS_WALLET,
      buyerId, phone: customerPhone,
    });

    // PIN threshold keys off the FACE subtotal — the service fee must not shift it.
    if (cart.faceTotal >= 50 && !keshlessPin) {
      throw new Error('PIN required for purchases of E50 or more');
    }

    const result = await TicketService.sellTickets({
      vendorId: cart.event.vendorId!.toString(),
      eventId,
      lines: cart.lines,
      customerName, customerPhone, customerEmail, buyerId,
      paymentMethod: PaymentMethod.KESHLESS_WALLET,
      keshlessCardNumber, keshlessPin,
      soldBy: cart.event.vendorId!.toString(),
      soldByType: 'vendor',
      channel: SalesChannel.ONLINE,
      serviceFeeAmount: cart.serviceFeeAmount,
      absorbedServiceFeeAmount: cart.absorbedServiceFeeAmount,
    });
```

Its return value keeps `totalAmount` (now `cart.faceTotal`) and `quantity` (now
`cart.totalQuantity`); `tickets[].ticketType` comes from each minted ticket
rather than a single tier.

- [ ] **Step 5: Rewrite `claimFreeTicket` over the cart**

Same shape, plus keep the free-only guard — now across every line, so one paid
tier cannot ride along in a "free" claim:

```ts
    const cart = await resolveCart({ eventId, items, method: PaymentMethod.CASH, buyerId, phone: customerPhone });

    const paid = cart.lines.find((l) => l.unitPrice > 0);
    if (paid) {
      throw new Error(`${paid.ticketType.name} is not free — please choose a payment method`);
    }
```

then `sellTickets({ ..., lines: cart.lines, paymentMethod: PaymentMethod.CASH, serviceFeeAmount: 0 })`.

- [ ] **Step 6: Update the controllers**

In `src/controllers/public.controller.ts`, destructure `items` instead of
`ticketTypeId`/`quantity` from the validated body and pass it straight through to
the service in both `purchaseTickets` and `claimFreeTicket`.

- [ ] **Step 7: Run the tests**

```bash
npx tsc --noEmit
npx jest src/services/__tests__/claimFreeTicket.multiline.test.ts --runInBand
npx jest src/services/__tests__/claimFreeTicket.security.test.ts src/services/__tests__/checkTicketAvailability.test.ts --runInBand
```
Expected: typecheck clean; all PASS. `claimFreeTicket.security.test.ts` calls the
old `{ ticketTypeId, quantity }` shape and must be updated to `items` — expected,
and part of this task. Keep its assertions identical: it is the regression guard
proving a paid tier can never be claimed free, and it must still prove that.

- [ ] **Step 8: Full suite and commit**

```bash
npx jest --runInBand 2>&1 | tail -30; echo "exit=$?"
```
Compare failures against the pre-change baseline: **3 known pre-existing
failures** (photo-gate 403s). Anything beyond those is a regression — fix before
committing.

```bash
git add -A src/
git commit -m "feat(purchase): buy multiple tiers in one wallet or free-claim checkout"
```

---

## Done when

- A single request buys 2 × General + 1 × VIP, minting 3 tickets under one sale
  with correct per-tier names and prices.
- A one-line cart produces the same sale, tickets, fee and `amountCharged` as
  before the change.
- The cap, restricted-tier and allocation rules reject at the service, not just
  the UI.
- The full suite shows only the 3 known pre-existing failures.
- `releaseHeldReservations.ts` exists and is documented as a pre-deploy step.

Slice 2 (the five async rails: MoMo, Peach, Yoco, YeboPay, DeltaPay) follows,
and is where `ReservationService.reserve`'s `lines` argument finally carries more
than one entry in production.
