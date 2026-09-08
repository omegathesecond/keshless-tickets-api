# Multi-tier checkout — design

**Date:** 2026-09-08
**Status:** approved (decisions confirmed 2026-09-08), implementation not started
**Scope:** buyer web, POS app, reseller allocations — every surface that sells a ticket

## Problem

A buyer can only buy one tier per checkout. Wanting 2 × General and 1 × VIP means
two separate purchases: two payments, two service fees, two confirmation
messages, two rows in the organizer's sales history. Every rail — MTN MoMo,
Peach, Yoco, YeboPay, Keshless wallet, DeltaPay and the free-claim path — takes
a single `ticketTypeId` plus a `quantity`.

## What the codebase already supports

The single-tier assumption is much shallower than it looks. It lives in the
*request shape*, not the data model.

| Thing | Shape today | Needs changing? |
|---|---|---|
| `TicketSale` | `ticketIds[]`, `quantity`, aggregate money. **No `ticketTypeId` field.** | **No** |
| `Ticket` | Carries its own `ticketType` + `price` | **No** |
| `Event.ticketTypes[]` | Per-tier `available`, `reserved`, `isSoldOut`, `waiveServiceFee`, `restrictToMethod` | **No** |
| `TicketReservation` | One `ticketTypeId` + `quantity`, `saleId` **unique** | **Yes** — see below |
| `sellTickets` | Single `ticketTypeId`/`quantity`; documented as *"the SINGLE mint choke point every sale path funnels through"* | **Yes** |
| `checkTicketAvailability` | Single tier | **Yes** |
| 7 rails' `initiate*` | Single tier in the params | **Yes** |

A sale is therefore *already* a container of arbitrary tickets. **No migration of
`TicketSale` or `Ticket` is required**, and historical sales stay readable
unchanged.

`sellTickets` having exactly four callers — `tickets.controller` (POS),
`resellerSale.service`, `purchaseForCustomer`, `claimFreeTicket` — is what makes
this tractable: the mint path changes in one place.

## Design

### 1. The cart line

```ts
export interface CartLine { ticketTypeId: string; quantity: number; }
```

Requests take `items: CartLine[]` (1..N). Duplicate `ticketTypeId`s are merged
before validation, so `[{A,1},{A,2}]` is treated as `{A,3}` and cannot be used to
sidestep a per-tier or per-account check.

### 2. `resolveCart()` — one validator for every rail

A new `src/services/cart.service.ts` exposes the whole of the pre-payment
decision in one place, so no rail can drift from another:

```ts
resolveCart(input: {
  eventId: string;
  items: CartLine[];
  method: PaymentMethod;
  buyerId?: string;
  phone?: string;
}): Promise<ResolvedCart>
```

`ResolvedCart` carries the event, the resolved lines (each with its tier
snapshot, unit price and line subtotal), `faceTotal`, `serviceFeeAmount`,
`absorbedServiceFeeAmount` and `amountCharged`.

It performs, in order:

1. Event is `PUBLISHED` and `assertCarrotTicketing`.
2. Every `ticketTypeId` exists on the event.
3. Per line: not `isSoldOut`, and `available >= quantity`.
4. **Payment-method compatibility** (decision 2 below).
5. **Per-account cap** (decision 3 below).
6. **Service fee** (decision 1 below).

### 3. Confirmed decisions

**Decision 1 — service fee is computed per line and summed.**
`waiveServiceFee` is a per-tier property, so it is honoured per tier. A waived
tier stays fee-free even when bought alongside a paid one, which is what the
tier promises on its own. `computeServiceFee` is called once per line with that
line's `subtotal`, `quantity` and `waiveServiceFee`, and the results are summed.

This matters because the fee is **per ticket, not per order** — summing per line
is also the only arrangement that keeps a mixed cart's fee identical to what the
buyer would have paid buying each tier separately. No buyer is better or worse
off for using the basket.

`organizerAbsorbsServiceFee` is per-event, so it applies uniformly and continues
to route the fee into `absorbedServiceFeeAmount` rather than the buyer's total.
Free lines (`price 0`) carry no fee, as today.

**Decision 2 — a restricted tier is exclusive; mixed carts are rejected.**
A tier with `restrictToMethod` (e.g. a DeltaPay allocation block) may only be
bought on its own. `resolveCart` rejects any cart containing a restricted tier
alongside any other tier, with an explicit message naming the tier. The buyer UI
enforces the same rule up front: selecting a restricted tier clears the other
selections and vice versa, so the state is never reachable by normal use.

Rationale: the alternative — offering only the methods valid for *all* lines —
almost always yields an empty method list, leaving the buyer with a cart they
cannot pay for and no explanation.

**Decision 3 — `maxTicketsPerAccount` is summed across the cart AND existing tickets.**
The cap is a per-**event** field, so it must be evaluated as
`alreadyOwned + sum(cart quantities) <= maxTicketsPerAccount`. Checking it per
line would let a 4-ticket cap on a 9-tier event yield 36 tickets. Absent means
unlimited, unchanged.

This closes a bypass that only exists once multi-tier ships, so it is part of
this change, not a follow-up.

### 4. `TicketReservation` — the one schema change

Today one sale holds one reservation for one tier, and `saleId` is `unique`.
A mixed cart needs to hold inventory on several tiers for one sale.

**Chosen shape: keep one reservation document per sale; move the tier detail into an array.**

```ts
{ eventId, saleId /* still unique */, lines: [{ ticketTypeId, quantity }], expiresAt, status }
```

`saleId`'s uniqueness is load-bearing — `confirm(saleId)` and `release(saleId)`
are idempotent precisely because they `findOne` a single document — so it is
preserved. `ReservationService.reserve/confirm/release/sweepExpired` keep their
signatures; only the inner `adjustReserved` call becomes a loop over `lines`.

The rejected alternative (drop the unique index, one doc per line) would make
confirm/release multi-document operations and lose that idempotency for free.

**Deploy ordering — no compatibility shim.** Reservations are short-lived by
construction (`expiresAt`), so there is no historical backfill: `status:
'confirmed'` and `'released'` documents are inert records that nothing reads
again. The only live concern is `status: 'held'` documents in the old shape at
the moment of cutover.

These are drained rather than supported. A one-off migration
(`src/scripts/releaseHeldReservations.ts`) runs immediately before the slice-1
deploy: it releases every held reservation through today's code path — restoring
each tier's `reserved` count and letting the existing sweep rules decide the
sale's fate — so the new code never meets an old-shaped held document. Then the
`lines` shape is the only shape that exists.

The rejected alternative was a dual-read fallback (`lines ?? {ticketTypeId,
quantity}`) deleted a cycle later. It was rejected because it puts
compatibility code on a live payment path, and because "delete it next cycle"
reliably becomes permanent. This project's default is not to add backward
compatibility, and a 30-second drain buys the same safety with no code.

**Cost of the drain:** a buyer who is mid-checkout at cutover loses their
inventory hold and must re-select. Their *payment* is unaffected — an
already-authorised sale is resolved by its rail's finalizer/reconciler, which
does not consult the reservation. Deploy during a low-traffic window; the blast
radius is a handful of abandoned carts at most.

### 5. Rails

Each `initiate*Purchase` changes only at its edges: it takes `items` instead of
`ticketTypeId`/`quantity`, calls `resolveCart`, and passes the resolved lines to
`sellTickets`. The provider-facing part of every rail (checkout creation,
webhooks, finalizers, reconcile sweeps) reads money off the sale, which is
already aggregate, and therefore **does not change at all**. The same is true of
`finalizeMomoSale`, `finalizeCardSale`, `finalizeYocoSale`,
`finalizeYeboPaySale`, `finalizeDeltapaySale` and their reconcilers.

`sellTickets` takes `lines: ResolvedLine[]`, mints each line's tickets inside the
existing session/transaction, and records the aggregate on the sale exactly as
today.

### 6. Surfaces

- **Buyer web** (`EventPage`, `EventQuickView`, `PurchaseModal`): per-tier
  quantity steppers replacing single-tier selection; an order summary listing
  each line with its subtotal, then fees and total. `PurchaseModal` takes
  `items` + the resolved totals instead of `ticketType`/`quantity`.
- **POS app** (Flutter, `api.dart` + `pos_page.dart`): a basket of tiers. The
  cashless side already has a basket pattern to follow.
- **Reseller** (`resellerSale.service`, allocation portal): allocation blocks are
  per-tier and pre-bought, so a reseller cart is validated against each line's
  allocation balance; commission and platform fee are computed on the cart's
  face total, as today.
- **Dashboard**: sales history and the event Financials tab read aggregate money
  off the sale and need no change; the sale detail view gains a per-line
  breakdown derived from `ticketIds`.

## Build order

Each slice ships and is verified independently.

1. **API cart core** — `CartLine`, `resolveCart`, `sellTickets(lines)`,
   `TicketReservation.lines`, per-account cap across the cart. Free-claim and
   Keshless wallet rails migrated. No behaviour change for single-line carts.
2. **API remaining rails** — MoMo, Peach, Yoco, YeboPay, DeltaPay.
3. **Buyer web** — steppers, order summary, restricted-tier exclusivity.
4. **POS app** — basket.
5. **Reseller** — allocation-aware multi-line carts.

Slices 1–2 are behaviour-preserving for existing callers: a one-line cart must
produce a byte-identical sale to today. That equivalence is the primary test.

## Testing

- **Equivalence:** for each rail, a single-line cart produces the same sale,
  tickets, fee and `amountCharged` as the pre-change code path.
- **Fee correctness:** a mixed waived/non-waived cart's fee equals the sum of the
  two tiers bought separately.
- **Cap:** `alreadyOwned + cart > cap` is rejected, including when the cart
  splits across tiers, and including duplicate `ticketTypeId` entries.
- **Restricted tiers:** a cart mixing restricted and unrestricted is rejected
  server-side even when the UI is bypassed.
- **Inventory:** a mixed cart holds and releases `reserved` on every tier; an
  expired mixed hold releases all lines; partial availability rejects the whole
  cart without holding anything.
- **Oversell:** concurrent carts competing for the last tickets of a shared tier.

## Out of scope

- Splitting one basket across multiple payments.
- Cross-event carts — a cart is always one event.
- Changing what a service fee *costs*; only how a mixed cart's fee is assembled.
