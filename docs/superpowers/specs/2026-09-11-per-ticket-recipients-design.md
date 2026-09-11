# Per-Ticket Recipients, Download & Send — Design

Date: 2026-09-11
Status: approved (design), not yet implemented
Repos: `carrot-tickets-api`, `carrot-tickets-dashboard`

## Problem

An organizer sells 5 tickets at the box office as ONE sale to ONE buyer. Today
every one of those tickets carries that buyer's name and phone, the success
dialog can only print them as a 58mm thermal receipt, and "Send via SMS" sends
all 5 codes to the single sale phone number.

The organizer needs to hand each ticket to a different person: generate all of
them at once, download them individually or together, and send each one to its
own recipient by SMS or email.

Compounding it: `TicketService.sellTickets` sends no SMS or email at all (see
`carrot-organizer-boxoffice-sends-no-sms`), so the send path is the walk-up
buyer's only digital ticket.

## What already exists (do NOT rebuild)

`TicketPdfService` is complete, with ONE shared `drawTicketPage` routine so every
surface renders an identical ticket card:

- `buildTicketPdfBuffer(ticket)` — single ticket PDF bytes
- `buildBundlePdfBuffer(tickets)` — N tickets, one page each, one PDF
- `ensureTicketPdf(ticket)` — lazy, idempotent, R2-cached **shareable URL**
- `GET /api/tickets/:ticketId/pdf` — vendor-ownership-checked, returns the R2 URL
  status envelope. Already organizer-accessible; the dashboard has never called it.

`ITicket` already carries `customerName` / `customerPhone` / `customerEmail`.
`buildTicket` currently copies the sale's values onto every ticket — the model
already supports per-ticket recipients, only the ability to SET them is missing.

`MAX_BUNDLE_TICKETS` is 100.

## Decisions (locked)

1. Recipients captured **optionally at the till** AND **editable afterwards**.
2. "Afterwards" means **within the success dialog only** for this iteration. A
   sales-list surface for reassigning older sales is explicitly out of scope.
3. Send channel is **per recipient: SMS or email**, chooser per ticket.
4. Both channels send the **same content: code + link** to the R2 PDF.
   `EmailService` gains no attachment support — link only.
5. "Download all" ships as **two buttons**: one multi-page PDF, and a ZIP of
   separate PDFs.
6. PDFs are generated **server-side** (approach A). The dashboard never renders a
   ticket itself — a second renderer would drift from `drawTicketPage`.
7. The per-ticket panel is **opt-in by prop**. The reseller POS keeps today's
   dialog and needs no reseller-side endpoints.

## Part A — API: per-ticket recipients

### At sale time

`SellTicketsRequest.items[]` gains an optional sparse array:

```ts
items: Array<{
  ticketTypeId: string;
  quantity: number;
  recipients?: Array<{ name?: string; phone?: string; email?: string }>;
}>
```

Applied in order to that line's minted tickets. Entries may be omitted or
partially filled; anything absent falls back to the sale's buyer details exactly
as today. `recipients.length > quantity` is a 400.

Omitting `recipients` entirely MUST reproduce current behaviour byte for byte —
this is the backward-compatibility guarantee and gets its own test.

Phone values go through the existing `normalizePhone`; emails are lowercased —
the same treatment `buildTicket` already applies.

### After the sale

`PATCH /api/tickets/:ticketId/recipient` — `{ name?, phone?, email? }`
Vendor-ownership checked, `SELL_TICKETS`. Persists onto the ticket so a later
resend needs no retyping.

Refuses with 409 when `ticket.status === 'used'`: silently moving an
already-scanned ticket to a new name is how gate disputes start. The UI states
the reason rather than hiding the row.

## Part B — API: download

| Route | Notes |
|---|---|
| `GET /tickets/:ticketId/pdf/download` | Streams PDF **bytes**. Mirrors the buyer route `GET /public/tickets/:ticketId/pdf`, swapping the buyer check for vendor ownership. |
| `POST /tickets/pdf-bundle` | `{ ticketIds: string[] }` → one multi-page PDF. Mirrors the buyer bundle, reuses `buildBundlePdfBuffer`, keeps the 100 cap. |

Both reuse `TicketPdfService` unchanged.

**Route registration:** `tickets.route.ts` already carries a warning that
`/:ticketId/pdf`'s suffix "keeps this clear of the vendor-scoped `/events/:eventId`
and other routes above". The new `/:ticketId/...` routes are bare-parameter
patterns and must be registered so they cannot shadow literal sibling paths —
`POST /:ticketId/send` sits one segment deep alongside `POST /sales/sell`, which
matches only because the second segment differs. Add each new route with a test
that an existing literal route still resolves.

**Why a bytes route when `GET /tickets/:ticketId/pdf` exists:** that route returns
an R2 URL. The ZIP must be assembled from real bytes in the browser, and fetching
R2 cross-origin depends on that bucket's CORS policy — not a foundation to build
on. So: **bytes endpoint feeds downloads and the ZIP; the R2 cached URL feeds the
link inside SMS/email.**

## Part C — API: per-ticket send

`POST /tickets/:ticketId/send` — `{ channel: 'sms' | 'email' }`, `SELL_TICKETS`,
vendor-ownership checked.

Sends to the recipient **stored on the ticket** — this endpoint never takes a
recipient in its body, so there is exactly one source of truth. The dashboard
therefore PATCHes a dirty row and only sends once that resolves; a row with
unsaved edits shows as unsaved rather than sending to the stale stored value.

Validates before dispatching:
`sms` with no phone, or `email` with no address, is a 400 and nothing is sent —
an SMS credit is spent either way, so the guard belongs ahead of the send.

Reuses `SmsService.sendTicketConfirmation` / `EmailService.sendTicketConfirmation`
with a single-element `TicketSummary[]`, including `startTime` (its absence is
what made reseller SMS print 02:00). The link is `ensureTicketPdf(ticket).pdfUrl`.

A gateway rejection returns **502**, never a 200 carrying `sent: false` — matching
`POST /tickets/sales/:saleId/send-sms` shipped 2026-09-11.

The existing sale-level `send-sms` endpoint is untouched.

## Part D — Dashboard

### `TicketSuccessDialog`

The ticket-ID chips become rows, one per ticket:

```
TKT-4F9A2C  [name]  [phone | email]  (SMS ▾)   [Send]  [↓]
```

Each row owns its state — idle / sending / sent / failed-with-reason — so a
partial failure is visible per recipient. There is no aggregate success toast.

Header actions: **Print** (unchanged), **Download all (PDF)**, **Download all (ZIP)**.

The panel is opt-in: the dialog renders today's aggregate view unless the owning
page passes the per-ticket handlers, following the `sendSms` injection pattern
added 2026-09-11. `ResellerPosPage` passes nothing and is unaffected.

Above `MAX_INLINE_RECIPIENT_ROWS = 20` the panel collapses to the aggregate view
plus the bulk-download buttons — 100 editable rows is not a usable dialog.

### Sell form

A collapsed **"Assign tickets to individual people (optional)"** section under the
cart, expanding to one row per ticket in the basket, feeding `items[].recipients`.
Left untouched, the request is byte-identical to today's.

### ZIP

`jszip` added to the dashboard. Built from the bytes endpoint.

**All-or-nothing:** if any ticket's bytes fail, the whole download fails loudly.
A ZIP silently holding 4 of 5 tickets means someone discovers the fifth at the gate.

## Error handling

- Per-row send results, never batched into one verdict.
- Channel/recipient mismatch refused before dispatch (400).
- Gateway rejection → 502 → failed row.
- `PATCH` on a used ticket → 409, surfaced in the row.
- ZIP failure is total and explicit.
- No silent fallbacks anywhere: a missing recipient is an error, never a
  substitution of the buyer's details at send time.

## Testing

API (mirroring `vendorSendSaleSms.route.test.ts`):

- **Cross-vendor isolation on all four new routes** — the security surface. One
  organizer must never pull another's QR codes.
- Bundle with one foreign ticket → 403, nothing rendered.
- `recipients.length > quantity` → 400.
- **Omitting `recipients` reproduces current behaviour** — the compatibility pin.
- `sms` without phone / `email` without address → 400, gateway not called.
- Gateway rejection → 502.
- `PATCH` on a `used` ticket → 409.

Dashboard:

- One row per ticket; row states transition independently.
- **Dialog without the opt-in prop renders exactly as today** — pins the reseller POS.
- Sell form with the section untouched sends today's request shape.

TDD throughout.

## Rollout

Additive: new routes, `recipients` optional. No feature flag — a dashboard built
before the API lands simply never calls the new endpoints.

Deploy **API first**, wait for the Cloud Run revision to hold 100% traffic, then
the dashboard (see `contracts-api-deploy-via-gcloud-triggers`; verify by image
digest, not by probing for a 401).

## Out of scope

- Reassigning recipients from the sales list / older sales.
- WhatsApp as a send channel.
- PDF email attachments.
- Reseller POS per-ticket recipients.
- Auto-send at sale time (explicitly declined — it would bill a credit per sale).
