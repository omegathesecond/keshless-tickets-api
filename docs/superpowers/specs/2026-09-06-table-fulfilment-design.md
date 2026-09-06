# Table fulfilment: paid → handed out → collected

**Date:** 2026-09-06
**Repos:** `carrot-tickets-api`, `carrot-tickets-pos-app`, `carrot-tickets-dashboard`

## Problem

A waiter opens a table, adds items from any stall, and settles it against a
wristband. That is the whole lifecycle today: `open → settled | voided`. It is
a *money* state machine and nothing more.

Nothing records that the Bar actually handed the drinks over. The stall
operator sees the money land in Takings with no idea which table it belongs
to, so "is this table paid?" is answered by the waiter saying so. Two
behaviours follow from that gap:

- a waiter can collect stock for a table that was never settled
- a table that was settled can be collected twice, and nothing notices

Two existing bugs compound it:

- a waiter whose session is restored from disk lands on the reseller
  sell-tickets screen, not the floor
- granting a waiter the settling permission from the dashboard has no effect
  until they sign out and back in

## Current state

`Table` (api/src/models/table.model.ts) holds `items[]` with a snapshotted
`merchantId` per line, a `subtotal`, and a `revision` counter used as an
optimistic-concurrency token during settlement. `TableService.settle` prices
the lines, then in one transaction debits the wallet, writes the ledger
postings and creates one `MerchantCharge` per stall.

`TablePage` in the POS app already groups a table's lines by `merchantId`,
because a normal round spans stalls.

`MerchantCharge` carries `waiterId` but no `tableId`.

## Design

### Fulfilment is per stall, per table

A table with Bar drinks and Kitchen food is two handovers by two people at two
counters. One flag on the table cannot represent it: whoever tapped last would
be closing out stock they never touched.

So `Table` gains a `fulfilment[]` array — one row per stall that has a line on
the table:

```ts
fulfilment: [{
  merchantId: ObjectId,      // the stall
  status: 'new' | 'paid' | 'handed_out' | 'collected',
  handedOutAt?: Date,
  handedOutBy?: string,      // merchant operator id
  acceptedAt?: Date,
  acceptedBy?: string,       // waiter id
}]
```

Embedded rather than a separate `StallTicket` collection: a fulfilment row is
never read apart from its table, and embedding lets settlement flip every row
inside the transaction it already runs, under the `revision` guard already
protecting that flip. A separate collection would buy cleaner stall-side
queries at the cost of a second write in the money path.

### The state machine

```
new ──settle──> paid ──stall hands out──> handed_out ──waiter accepts──> collected
```

- `addItem` creates the stall's row at `new` if it is the first line from that
  stall. `removeItem` deletes the row when its last line goes.
- `settle` flips every row `new → paid`, in the same transaction and under the
  same `revision` guard as the money.
- the stall marks `paid → handed_out`
- the waiter accepts `handed_out → collected`

Both halves of the handshake are required. The stall cannot close a handover
the waiter never acknowledged, and the waiter cannot mark stock collected that
the stall never released — a disputed handover has two timestamps and two
actor ids behind it.

Every transition is guarded on the *expected current status*, so a double-tap
is refused rather than silently re-stamping. Voiding a table abandons its
fulfilment rows; a voided table appears in no tab.

### Derived table status, for the tabs

The waiter's three tabs are a projection, not a stored field:

| Tab | Condition |
|---|---|
| New | `status === 'open'` |
| Paid | `status === 'settled'` and at least one row is not `collected` |
| Collected | `status === 'settled'` and every row is `collected` |

### API

Waiter (`authenticateWaiter` + `MANAGE_TABLES`):

- `GET /api/waiter/tables` gains `?tab=new|paid|collected` and `?q=<search>`.
  The existing `?status=` filter stays — it selects the raw table status, a
  different question from the tab projection.
- `POST /api/waiter/tables/:id/stalls/:merchantId/accept` — the waiter's half.

Stall (`authenticateMerchant` + `MerchantPermission.CHARGE` — the same
operator who sells is the one who hands out):

- `GET /api/merchant/tables?status=paid|handed_out|collected` — tables
  carrying a line from *this* stall, with only this stall's lines projected.
- `POST /api/merchant/tables/:id/hand-out` — the stall's half.

A stall must never see another stall's lines or totals. The merchant-side
projection filters `items` to the caller's own `merchantId` and recomputes the
subtotal from that subset.

### Search

`?q=` matches the table `label`, case-insensitively, anchored nowhere (a
substring). Labels already hold both numbers and names — "Mza", "2", "1" in
production today — so one field answers "search table / name". Escaped before
it reaches a regex, so a label containing `.` or `(` cannot become a pattern.

## The two bugs

### Waiter lands on the sell-tickets screen

`splash_page.dart` `_go()` branches on merchant / cashier / register / gate and
falls through to `HomePage()` — the reseller screen. It has no `isWaiter`
branch. `login_page.dart` handles waiters correctly, so this only bites when a
stored session is restored on relaunch, which is why it reads as intermittent.

Fix: the missing branch, plus a regression test that a restored waiter session
routes to `WaiterShell`.

### The settling toggle does nothing

`WaiterAuthService.login` bakes `permissions` into a 7-day JWT.
`verifyToken` reads `decoded.permissions`, and `requireWaiterPermission`
checks that frozen list. The dashboard toggle writes `waiter.grants` in Mongo;
nothing re-reads it. The app compounds it by decoding the same stale token to
decide whether to render the Settle button.

Commit `d382b17` already fixed this class of staleness for event scope and
employment — `waiterScope()` re-reads the waiter row per request so Disable
takes effect on a handheld already in someone's pocket. Permissions were left
on the token.

Fix, mirroring that precedent:

1. `requireWaiterPermission` re-reads `waiter.grants` from the row and checks
   the live permission set. Fails closed on a missing or deactivated row.
2. `GET /api/waiter/events` returns the live `permissions` array.
3. `Session.canSettleTables` reads what the server said, not the JWT.

The token keeps carrying `permissions` — it is the fallback before the first
`events` call returns, and removing it would be a wire-format break for no
gain — but it is no longer what any decision is made on.

## POS app

**Waiter home** — New / Paid / Collected tabs and a search field over the
label. Tab and query go to the server rather than filtering a local list, so a
table another waiter settled shows up in the right tab on refresh.

**TablePage** — each stall section gains a status chip, and an Accept button
on the sections sitting at `handed_out`.

**Stall app** — a fourth tab in `MerchantShell`: Charge / Takings / Stock /
Tables. Lists this stall's tickets, filtered by status, with a Hand out
button. Rendered from the merchant-side projection, so it shows only this
stall's lines and its own share of the total.

**Cart bottom sheet** — `BasketPanel` caps its line area at 35% of screen
height and appends new lines at the bottom, so on a small handheld the cart
eats the product grid and a newly-tapped item lands out of sight. Cap to two
rows and scroll; render newest-first so the waiter sees the list updating as
they tap.

**Charge screen** — while search is active, collapse the tall header and the
Basket/Amount toggle, handing that vertical space to the product grid. The
grid is what the operator is searching *in*; the chrome above it is what makes
the results unreadable.

## Dashboard

Cashless → Catalogue gains category tabs, matching the Menu tab's treatment.
Stock figures are already on the rows; this is the grouping, not new data.

## Testing

- Model: fulfilment row shape, status enum, the per-stall uniqueness.
- Service: row created on first line from a stall and removed with the last;
  settle flips every row atomically; each transition refuses a wrong-state
  input; the merchant projection never leaks another stall's lines.
- Routes: the two new endpoints, their permission gates, tab/search filtering.
- Permissions: a waiter granted settling mid-session settles without
  re-login; a revoked one is refused on the next request.
- App: splash routes a restored waiter session to `WaiterShell`; tabs and
  search; Accept only where `handed_out`; basket caps at two visible rows and
  orders newest-first.
