# Per-Ticket Recipients, Download & Send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organizer sell N tickets in one box-office sale, give each ticket its own recipient, download them individually / as one PDF / as a ZIP, and send each ticket to its own person by SMS or email.

**Architecture:** All PDF rendering stays server-side in the existing `TicketPdfService` (one `drawTicketPage` routine, already built). Four new vendor-scoped routes are added to the API; the dashboard wires them into the existing `TicketSuccessDialog`, which gains an opt-in per-ticket panel. `ITicket` already has per-ticket customer fields — no schema migration.

**Tech Stack:** Node/Express/TypeScript/Mongoose + Jest/supertest (API); React/Vite/TypeScript + Vitest/Testing-Library (dashboard); pdfkit via `TicketPdfService`; `jszip` (new, dashboard only).

**Spec:** `docs/superpowers/specs/2026-09-11-per-ticket-recipients-design.md`

## Global Constraints

- Tasks 1–5 run in the **API** repo (`carrot-tickets-api`); Tasks 6–10 run in the **dashboard** repo (`carrot-tickets-dashboard`). Deploy API first.
- Every new API route is vendor-scoped: `requireTicketsPermission(TicketsPermission.SELL_TICKETS)` + ownership on `ticket.vendorId`, with `ticketsUser.isSuperAdmin` bypass.
- `MAX_BUNDLE_TICKETS = 100` (existing constant in `src/controllers/ticketPdf.controller.ts`).
- `MAX_INLINE_RECIPIENT_ROWS = 20` (new, dashboard).
- A gateway rejection is **502**, never `200 { sent: false }`.
- No silent fallbacks. A missing recipient is an error; never substitute the buyer's details at send time.
- Omitting `recipients` from a sell request MUST reproduce today's behaviour exactly.
- Run API tests with `--runInBand`. Check `df -h /System/Volumes/Data` first — MongoDB refuses to start under 500 MB free and every suite then fails with a misleading `MongoServerError`.

---

## Part 1 — API

### Task 1: Per-ticket recipients at sale time

**Files:**
- Modify: `src/validators/tickets.validator.ts:432-439` (items schema)
- Modify: `src/services/ticket.service.ts:561-565` (transactional mint loop) and `:590-601` (no-session retry loop)
- Test: `src/routes/__tests__/vendorSellRecipients.route.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `items[].recipients?: Array<{ name?: string; phone?: string; email?: string }>` accepted by `POST /api/tickets/sales/sell`; minted tickets carry their own `customerName` / `customerPhone` / `customerEmail`.

⚠️ **`sellTickets` mints in TWO loops.** The transactional loop and the no-session retry fallback both call `buildTicket`. The retry loop's own comment warns that skipping it "would silently mint the wrong tiers" — the same applies to recipients. Change both or the fallback drops every recipient.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorSellRecipients.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { seedEventWithTiers } from '../../__tests__/helpers/fixtures';
import { PaymentConfigService } from '@services/paymentConfig.service';
import { SmsService } from '@services/sms.service';
import { EmailService } from '@services/email.service';
import { Ticket } from '@models/ticket.model';
import { Vendor } from '@models/vendor.model';
import { signVendorToken } from '../../__tests__/helpers/auth';
import mongoose from 'mongoose';

let token = ''; let vendorId = '';

beforeAll(connectTestDb);
beforeEach(async () => {
  await PaymentConfigService.update({ platformFeePercent: 0, cashEnabled: true });
  jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
  jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);
  const v = await Vendor.create({
    businessName: 'Box Office Co', email: 'box@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  vendorId = v._id.toString();
  token = signVendorToken(vendorId, { permissions: ['tickets:sell_tickets'] });
});
afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
afterAll(disconnectTestDb);

const sell = (body: Record<string, unknown>) =>
  request(app).post('/api/tickets/sales/sell').set('Authorization', `Bearer ${token}`).send(body);

it('assigns each ticket its own recipient, in order', async () => {
  const { eventId, ticketTypeIds } = await seedEventWithTiers(
    [{ name: 'General', price: 100, quantity: 10 }],
    { vendorId: new mongoose.Types.ObjectId(vendorId) },
  );

  const res = await sell({
    eventId,
    items: [{
      ticketTypeId: ticketTypeIds[0], quantity: 3,
      recipients: [
        { name: 'Thandi', phone: '+26876111111' },
        { name: 'Sipho', email: 'Sipho@Example.com' },
      ],
    }],
    paymentMethod: 'cash',
    customerName: 'Walk-up', customerPhone: '+26878422613',
  });

  expect(res.status).toBe(201);
  const ids = res.body.data.tickets.map((t: any) => t._id);
  const tickets = await Ticket.find({ _id: { $in: ids } }).sort({ createdAt: 1 });

  expect(tickets[0]!.customerName).toBe('Thandi');
  expect(tickets[0]!.customerPhone).toBe('+26876111111');
  expect(tickets[1]!.customerName).toBe('Sipho');
  expect(tickets[1]!.customerEmail).toBe('sipho@example.com'); // lowercased
  // Third has no recipient entry -> falls back to the buyer, exactly as today.
  expect(tickets[2]!.customerName).toBe('Walk-up');
  expect(tickets[2]!.customerPhone).toBe('+26878422613');
});

it('omitting recipients reproduces current behaviour', async () => {
  const { eventId, ticketTypeIds } = await seedEventWithTiers(
    [{ name: 'General', price: 100, quantity: 10 }],
    { vendorId: new mongoose.Types.ObjectId(vendorId) },
  );
  const res = await sell({
    eventId,
    items: [{ ticketTypeId: ticketTypeIds[0], quantity: 2 }],
    paymentMethod: 'cash',
    customerName: 'Walk-up', customerPhone: '+26878422613',
  });
  expect(res.status).toBe(201);
  const tickets = await Ticket.find({ saleId: res.body.data.sale._id });
  expect(tickets).toHaveLength(2);
  for (const t of tickets) {
    expect(t.customerName).toBe('Walk-up');
    expect(t.customerPhone).toBe('+26878422613');
  }
});

it('rejects more recipients than the line quantity', async () => {
  const { eventId, ticketTypeIds } = await seedEventWithTiers(
    [{ name: 'General', price: 100, quantity: 10 }],
    { vendorId: new mongoose.Types.ObjectId(vendorId) },
  );
  const res = await sell({
    eventId,
    items: [{
      ticketTypeId: ticketTypeIds[0], quantity: 1,
      recipients: [{ name: 'A' }, { name: 'B' }],
    }],
    paymentMethod: 'cash',
    customerName: 'Walk-up', customerPhone: '+26878422613',
  });
  expect(res.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/vendorSellRecipients.route.test.ts --runInBand`
Expected: FAIL — recipients are ignored, so ticket 0 is "Walk-up", and the over-length case returns 201 instead of 400.

- [ ] **Step 3: Widen the validator**

In `src/validators/tickets.validator.ts`, replace the `items` array item schema:

```ts
  items: Joi.array()
    .items(Joi.object({
      ticketTypeId: Joi.string().required().trim(),
      quantity: Joi.number().required().min(1).max(100),
      // Optional, sparse, applied in order to this line's tickets. Shorter than
      // quantity is fine — the rest fall back to the sale's buyer details.
      recipients: Joi.array()
        .items(Joi.object({
          name: Joi.string().trim().max(120).optional(),
          phone: Joi.string().trim().max(32).optional(),
          email: Joi.string().trim().email().max(254).optional(),
        }))
        .optional()
        .max(100),
    }).custom((value, helpers) => {
      if (Array.isArray(value.recipients) && value.recipients.length > value.quantity) {
        return helpers.error('any.invalid');
      }
      return value;
    }).messages({
      'any.invalid': 'Cannot supply more recipients than the quantity for a ticket type',
    }))
    .min(1)
    .max(20)
    .optional(),
```

- [ ] **Step 4: Carry recipients through to both mint loops**

In `src/services/ticket.service.ts`, `resolvedLines` must keep the line's recipients. Where `resolvedLines` is declared (~line 455) widen the type and push the field:

```ts
      const resolvedLines: Array<{
        ticketTypeId: string;
        ticketType: ITicketType;
        quantity: number;
        recipients?: Array<{ name?: string; phone?: string; email?: string }>;
      }> = [];
```

and in the `resolvedLines.push({ ... })` call add `recipients: line.recipients`.

Then flatten with the recipient attached (~line 561):

```ts
      // Flatten to one entry per ticket, pairing each with its own recipient
      // (absent entries fall back to the sale's buyer details).
      const flattened = resolvedLines.flatMap((line) =>
        Array.from({ length: line.quantity }, (_, i) => ({
          tier: line.ticketType,
          recipient: line.recipients?.[i],
        }))
      );
      for (const entry of flattened) {
        const ticket = this.buildTicket({
          eventId,
          vendorId,
          ticketType: entry.tier.name,
          price: entry.tier.price,
          customerName: entry.recipient?.name ?? customerName,
          customerPhone: entry.recipient?.phone ?? customerPhone,
          customerEmail: entry.recipient?.email ?? customerEmail,
          buyerId,
          currency: displayCurrency,
        });
```

And the SAME change in the no-session retry loop (~line 590):

```ts
            for (const retryEntry of flattened) {
              const t = this.buildTicket({
                eventId,
                vendorId,
                ticketType: retryEntry.tier.name,
                price: retryEntry.tier.price,
                customerName: retryEntry.recipient?.name ?? customerName,
                customerPhone: retryEntry.recipient?.phone ?? customerPhone,
                customerEmail: retryEntry.recipient?.email ?? customerEmail,
                buyerId,
                currency: displayCurrency,
              });
              await t.save();
              ticketsWithoutSession.push(t);
            }
```

`buildTicket` already normalises phones and lowercases emails — no extra handling needed.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/routes/__tests__/vendorSellRecipients.route.test.ts --runInBand`
Expected: PASS (3 tests)

- [ ] **Step 6: Verify nothing else regressed**

Run: `npx jest src/routes/__tests__/vendorSellCart.route.test.ts src/services/__tests__/resellerSale.service.test.ts --runInBand`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/validators/tickets.validator.ts src/services/ticket.service.ts src/routes/__tests__/vendorSellRecipients.route.test.ts
git commit -m "feat(sales): optional per-ticket recipients on box-office sales"
```

---

### Task 2: PATCH a ticket's recipient

**Files:**
- Modify: `src/controllers/tickets.controller.ts` (add `updateTicketRecipient`)
- Modify: `src/routes/tickets.route.ts` (register route)
- Test: `src/routes/__tests__/vendorTicketRecipient.route.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's per-ticket fields.
- Produces: `PATCH /api/tickets/:ticketId/recipient` → `200 { ticket: { ticketId, customerName, customerPhone, customerEmail } }`; `409` when `status === 'checked_in'`; `403` cross-vendor; `404` unknown.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorTicketRecipient.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { Ticket } from '@models/ticket.model';
import { Vendor } from '@models/vendor.model';
import { signVendorToken } from '../../__tests__/helpers/auth';
import mongoose from 'mongoose';

let token = ''; let vendorId = '';

beforeAll(connectTestDb);
beforeEach(async () => {
  const v = await Vendor.create({
    businessName: 'Box Office Co', email: 'box@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  vendorId = v._id.toString();
  token = signVendorToken(vendorId, { permissions: ['tickets:sell_tickets'] });
});
afterEach(async () => { await clearTestDb(); });
afterAll(disconnectTestDb);

async function makeTicket(owner: string, status = 'sold') {
  return Ticket.create({
    ticketId: `TKT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    saleId: new mongoose.Types.ObjectId(),
    eventId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(owner),
    ticketType: 'General', price: 100, status, // model enum: available|sold|checked_in|refunded|cancelled
    customerName: 'Walk-up', customerPhone: '+26878422613',
  });
}

const patch = (ticketId: string, body: any, as = token) =>
  request(app).patch(`/api/tickets/${ticketId}/recipient`)
    .set('Authorization', `Bearer ${as}`).send(body);

it('sets the recipient on the vendor own ticket', async () => {
  const t = await makeTicket(vendorId);
  const res = await patch(t.ticketId, { name: 'Thandi', phone: '+26876111111' });
  expect(res.status).toBe(200);
  const fresh = await Ticket.findById(t._id);
  expect(fresh!.customerName).toBe('Thandi');
  expect(fresh!.customerPhone).toBe('+26876111111');
});

it('refuses a ticket belonging to another vendor', async () => {
  const other = await Vendor.create({
    businessName: 'Rival', email: 'rival@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  const t = await makeTicket(other._id.toString());
  const res = await patch(t.ticketId, { name: 'Nope' });
  expect(res.status).toBe(403);
  const fresh = await Ticket.findById(t._id);
  expect(fresh!.customerName).toBe('Walk-up');
});

it('refuses to reassign an already-scanned ticket', async () => {
  const t = await makeTicket(vendorId, 'checked_in');
  const res = await patch(t.ticketId, { name: 'Thandi' });
  expect(res.status).toBe(409);
});

it('404s an unknown ticket', async () => {
  const res = await patch('TKT-NOPE', { name: 'X' });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/vendorTicketRecipient.route.test.ts --runInBand`
Expected: FAIL — 404 on every case, route not registered.

- [ ] **Step 3: Add the controller**

In `src/controllers/tickets.controller.ts`, above `getSales`:

```ts
  /**
   * Sales: set one ticket's own recipient. Tickets minted in one sale share the
   * buyer's details by default; this is how an organizer gives each ticket to a
   * different person.
   *
   * Refuses a scanned ticket: silently moving a used ticket to a new name is how
   * gate disputes start.
   */
  static async updateTicketRecipient(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      const { error, value } = Joi.object({
        name: Joi.string().trim().max(120).optional(),
        phone: Joi.string().trim().max(32).optional(),
        email: Joi.string().trim().email().max(254).optional(),
      }).or('name', 'phone', 'email').validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const ticketId = req.params['ticketId'];
      const ticket = await TicketService.resolveVendorTicket(
        ticketId as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false,
      );

      // A scanned ticket is CHECKED_IN — there is no USED member on this enum
      // (TicketStatus = available | sold | checked_in | refunded | cancelled).
      if (ticket.status === TicketStatus.CHECKED_IN) {
        return ApiResponseUtil.error(res, 'This ticket has already been scanned and cannot be reassigned', 409);
      }

      if (value.name !== undefined) ticket.customerName = value.name;
      if (value.phone !== undefined) ticket.customerPhone = normalizePhone(value.phone);
      if (value.email !== undefined) ticket.customerEmail = value.email.toLowerCase();
      await ticket.save();

      return ApiResponseUtil.success(res, {
        ticket: {
          ticketId: ticket.ticketId,
          customerName: ticket.customerName,
          customerPhone: ticket.customerPhone,
          customerEmail: ticket.customerEmail,
        },
      }, 'Recipient updated');
    } catch (err: any) {
      const msg = err?.message || '';
      if (/not authorized/i.test(msg)) return ApiResponseUtil.error(res, 'You are not allowed to access this ticket', 403);
      if (/not found/i.test(msg)) return ApiResponseUtil.error(res, 'Ticket not found', 404);
      console.error('Update ticket recipient error:', err);
      return ApiResponseUtil.error(res, msg || 'Failed to update recipient');
    }
  }
```

Add to that file's imports: `TicketStatus` from `@interfaces/ticket.interface` and `normalizePhone` from `@utils/phone.util` (check whether each is already imported before adding).

- [ ] **Step 4: Add the shared vendor-ticket resolver**

In `src/services/ticket.service.ts`, beside `sendSaleSmsForVendor`:

```ts
  /**
   * Load a ticket by its code (TKT-…) or Mongo _id and assert the calling vendor
   * owns it. Every vendor-scoped per-ticket route funnels through here so the
   * ownership rule has exactly one implementation.
   */
  static async resolveVendorTicket(
    idOrCode: string,
    vendorId: string,
    isSuperAdmin = false,
  ): Promise<ITicket> {
    const ticket = await TicketPdfService.resolveTicket(idOrCode);
    if (!ticket) {
      throw new Error(`Ticket not found: ${idOrCode}`);
    }
    if (!isSuperAdmin && ticket.vendorId?.toString() !== vendorId) {
      throw new Error('Not authorized to access this ticket');
    }
    return ticket;
  }
```

Add `import { TicketPdfService } from '@services/ticketPdf.service';` to `ticket.service.ts` if absent. If that import creates a cycle (`ticketPdf.service` importing `ticket.service`), instead inline the lookup here using `Ticket.findOne({ $or: [{ ticketId: idOrCode }, ...] })` mirroring `TicketPdfService.resolveTicket`, and note it in the commit.

- [ ] **Step 5: Register the route**

In `src/routes/tickets.route.ts`, immediately after the `POST '/sales/:saleId/send-sms'` block:

```ts
router.patch(
  '/:ticketId/recipient',
  requireTicketsPermission(TicketsPermission.SELL_TICKETS),
  TicketsController.updateTicketRecipient
);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/routes/__tests__/vendorTicketRecipient.route.test.ts --runInBand`
Expected: PASS (4 tests)

- [ ] **Step 7: Verify no route shadowing**

Run: `npx jest src/routes/__tests__/vendorSellCart.route.test.ts src/routes/__tests__/vendorSendSaleSms.route.test.ts --runInBand`
Expected: PASS — proves `/sales/sell` and `/sales/:saleId/send-sms` still resolve alongside the new bare-parameter route.

- [ ] **Step 8: Commit**

```bash
git add src/controllers/tickets.controller.ts src/services/ticket.service.ts src/routes/tickets.route.ts src/routes/__tests__/vendorTicketRecipient.route.test.ts
git commit -m "feat(tickets): PATCH a ticket's own recipient, vendor-scoped"
```

---

### Task 3: Vendor ticket-PDF bytes download

**Files:**
- Modify: `src/controllers/ticketPdf.controller.ts` (add `downloadVendorTicketPdf`)
- Modify: `src/routes/tickets.route.ts`
- Test: `src/routes/__tests__/vendorTicketPdf.route.test.ts` (create)

**Interfaces:**
- Consumes: `TicketService.resolveVendorTicket` (Task 2).
- Produces: `GET /api/tickets/:ticketId/pdf/download` → `application/pdf` bytes, `Content-Disposition: attachment`.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorTicketPdf.route.test.ts
import request from 'supertest';
import app from '@/app';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketPdfService } from '@services/ticketPdf.service';
import { Ticket } from '@models/ticket.model';
import { Event } from '@models/event.model';
import { Vendor } from '@models/vendor.model';
import { EventStatus } from '@interfaces/event.interface';
import { signVendorToken } from '../../__tests__/helpers/auth';
import mongoose from 'mongoose';

let token = ''; let vendorId = ''; let eventId: mongoose.Types.ObjectId;

beforeAll(connectTestDb);
beforeEach(async () => {
  const v = await Vendor.create({
    businessName: 'Box Office Co', email: 'box@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  vendorId = v._id.toString();
  token = signVendorToken(vendorId, { permissions: ['tickets:sell_tickets'] });
  const future = new Date(Date.now() + 7 * 86400000);
  const ev = await Event.create({
    vendorId: v._id, name: 'Gig', venue: 'Hall',
    eventDate: future, startTime: future, endTime: new Date(future.getTime() + 7200000),
    status: EventStatus.PUBLISHED, ticketTypes: [{ name: 'General', price: 100, quantity: 10, sold: 0 }],
  });
  eventId = ev._id;
  jest.spyOn(TicketPdfService, 'buildTicketPdfBuffer').mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
});
afterEach(async () => { await clearTestDb(); jest.restoreAllMocks(); });
afterAll(disconnectTestDb);

async function makeTicket(owner: string) {
  return Ticket.create({
    ticketId: `TKT-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    saleId: new mongoose.Types.ObjectId(), eventId,
    vendorId: new mongoose.Types.ObjectId(owner),
    ticketType: 'General', price: 100, status: 'sold',
  });
}

it('streams the PDF bytes for the vendor own ticket', async () => {
  const t = await makeTicket(vendorId);
  const res = await request(app)
    .get(`/api/tickets/${t.ticketId}/pdf/download`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('application/pdf');
  expect(res.headers['content-disposition']).toContain('attachment');
});

it('refuses another vendor ticket and renders nothing', async () => {
  const other = await Vendor.create({
    businessName: 'Rival', email: 'rival@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  const t = await makeTicket(other._id.toString());
  const res = await request(app)
    .get(`/api/tickets/${t.ticketId}/pdf/download`)
    .set('Authorization', `Bearer ${token}`);

  expect(res.status).toBe(403);
  expect(TicketPdfService.buildTicketPdfBuffer).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/vendorTicketPdf.route.test.ts --runInBand`
Expected: FAIL — route not registered.

- [ ] **Step 3: Add the controller method**

In `src/controllers/ticketPdf.controller.ts`, inside `TicketPdfController`:

```ts
  /**
   * GET /api/tickets/:ticketId/pdf/download — one ticket as PDF BYTES for an
   * organizer. Mirrors downloadTicketPdf, swapping the buyer check for vendor
   * ownership. Bytes (not the R2 URL) because the dashboard assembles the ZIP
   * client-side and cross-origin R2 fetches depend on bucket CORS.
   */
  static async downloadVendorTicketPdf(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser || {};
      const ticket = await TicketService.resolveVendorTicket(
        req.params['ticketId'] as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false,
      );
      await ticket.populate('eventId', EVENT_POPULATE_FIELDS);
      const buffer = await TicketPdfService.buildTicketPdfBuffer(ticket);
      sendPdf(res, buffer, `${sanitizeFilenamePart(ticket.ticketId)}.pdf`);
    } catch (error: any) {
      const msg = error?.message || '';
      if (/not authorized/i.test(msg)) return ApiResponseUtil.forbidden(res, 'You are not allowed to access this ticket');
      if (/not found/i.test(msg)) return ApiResponseUtil.notFound(res, 'Ticket not found');
      console.error('Vendor ticket PDF error:', error);
      return ApiResponseUtil.error(res, msg || 'Failed to generate ticket PDF');
    }
  }
```

Add `import { TicketService } from '@services/ticket.service';` to this controller.

- [ ] **Step 4: Register the route**

In `src/routes/tickets.route.ts`, beside the existing `router.get('/:ticketId/pdf', ...)`:

```ts
router.get(
  '/:ticketId/pdf/download',
  requireTicketsPermission(TicketsPermission.SELL_TICKETS),
  TicketPdfController.downloadVendorTicketPdf
);
```

Register it BEFORE `router.get('/:ticketId/pdf', ...)` to keep the two-segment and three-segment patterns unambiguous.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/routes/__tests__/vendorTicketPdf.route.test.ts --runInBand`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/controllers/ticketPdf.controller.ts src/routes/tickets.route.ts src/routes/__tests__/vendorTicketPdf.route.test.ts
git commit -m "feat(tickets): vendor-scoped ticket PDF bytes download"
```

---

### Task 4: Vendor bundle PDF

**Files:**
- Modify: `src/controllers/ticketPdf.controller.ts` (add `downloadVendorTicketsBundle`)
- Modify: `src/routes/tickets.route.ts`
- Test: `src/routes/__tests__/vendorTicketBundle.route.test.ts` (create)

**Interfaces:**
- Consumes: `TicketService.resolveVendorTicket` (Task 2).
- Produces: `POST /api/tickets/pdf-bundle` body `{ ticketIds: string[] }` → one multi-page PDF.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorTicketBundle.route.test.ts
// (same imports/beforeEach as vendorTicketPdf.route.test.ts, but mock the bundle builder)
//   jest.spyOn(TicketPdfService, 'buildBundlePdfBuffer').mockResolvedValue(Buffer.from('%PDF-1.4 bundle'));

it('bundles the vendor own tickets into one PDF', async () => {
  const a = await makeTicket(vendorId);
  const b = await makeTicket(vendorId);
  const res = await request(app)
    .post('/api/tickets/pdf-bundle')
    .set('Authorization', `Bearer ${token}`)
    .send({ ticketIds: [a.ticketId, b.ticketId] });

  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('application/pdf');
  const [tickets] = (TicketPdfService.buildBundlePdfBuffer as jest.Mock).mock.calls[0]!;
  expect(tickets).toHaveLength(2);
});

it('refuses a bundle containing one foreign ticket and renders nothing', async () => {
  const other = await Vendor.create({
    businessName: 'Rival', email: 'rival@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  const mine = await makeTicket(vendorId);
  const theirs = await makeTicket(other._id.toString());

  const res = await request(app)
    .post('/api/tickets/pdf-bundle')
    .set('Authorization', `Bearer ${token}`)
    .send({ ticketIds: [mine.ticketId, theirs.ticketId] });

  expect(res.status).toBe(403);
  expect(TicketPdfService.buildBundlePdfBuffer).not.toHaveBeenCalled();
});

it('rejects an empty or oversized list', async () => {
  const empty = await request(app).post('/api/tickets/pdf-bundle')
    .set('Authorization', `Bearer ${token}`).send({ ticketIds: [] });
  expect(empty.status).toBe(400);

  const huge = await request(app).post('/api/tickets/pdf-bundle')
    .set('Authorization', `Bearer ${token}`)
    .send({ ticketIds: Array.from({ length: 101 }, (_, i) => `TKT-${i}`) });
  expect(huge.status).toBe(400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/vendorTicketBundle.route.test.ts --runInBand`
Expected: FAIL — route not registered.

- [ ] **Step 3: Add the controller method**

```ts
  /** POST /api/tickets/pdf-bundle — several of THIS vendor's tickets as one PDF. */
  static async downloadVendorTicketsBundle(req: Request, res: Response): Promise<any> {
    try {
      const ticketIds: unknown = req.body?.ticketIds;
      if (!Array.isArray(ticketIds) || ticketIds.length === 0 || !ticketIds.every((id) => typeof id === 'string')) {
        return ApiResponseUtil.badRequest(res, 'ticketIds must be a non-empty array of ticket ids');
      }
      if (ticketIds.length > MAX_BUNDLE_TICKETS) {
        return ApiResponseUtil.badRequest(res, `Cannot bundle more than ${MAX_BUNDLE_TICKETS} tickets at once`);
      }

      const ticketsUser = (req as any).ticketsUser || {};
      // Resolve + authorise EVERY ticket before rendering anything: a bundle
      // holding one foreign ticket must render nothing at all.
      const tickets: ITicket[] = [];
      for (const id of ticketIds) {
        const t = await TicketService.resolveVendorTicket(
          id, ticketsUser.vendorId as string, ticketsUser.isSuperAdmin || false,
        );
        await t.populate('eventId', EVENT_POPULATE_FIELDS);
        tickets.push(t);
      }

      const buffer = await TicketPdfService.buildBundlePdfBuffer(tickets);
      sendPdf(res, buffer, 'tickets.pdf');
    } catch (error: any) {
      const msg = error?.message || '';
      if (/not authorized/i.test(msg)) return ApiResponseUtil.forbidden(res, 'You are not allowed to access one of these tickets');
      if (/not found/i.test(msg)) return ApiResponseUtil.notFound(res, 'Ticket not found');
      console.error('Vendor bundle PDF error:', error);
      return ApiResponseUtil.error(res, msg || 'Failed to generate ticket bundle');
    }
  }
```

- [ ] **Step 4: Register the route**

In `src/routes/tickets.route.ts`, with the other `/sales` routes (a literal path, so order is not delicate):

```ts
router.post(
  '/pdf-bundle',
  requireTicketsPermission(TicketsPermission.SELL_TICKETS),
  TicketPdfController.downloadVendorTicketsBundle
);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/routes/__tests__/vendorTicketBundle.route.test.ts --runInBand`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add src/controllers/ticketPdf.controller.ts src/routes/tickets.route.ts src/routes/__tests__/vendorTicketBundle.route.test.ts
git commit -m "feat(tickets): vendor-scoped multi-ticket PDF bundle"
```

---

### Task 5: Send ONE ticket to its own recipient

**Files:**
- Modify: `src/services/ticket.service.ts` (add `sendTicketToItsRecipient`)
- Modify: `src/controllers/tickets.controller.ts` (add `sendSingleTicket`)
- Modify: `src/routes/tickets.route.ts`
- Test: `src/routes/__tests__/vendorSendTicket.route.test.ts` (create)

**Interfaces:**
- Consumes: `TicketService.resolveVendorTicket` (Task 2); `TicketPdfService.ensureTicketPdf`.
- Produces: `POST /api/tickets/:ticketId/send` body `{ channel: 'sms' | 'email' }` → `200 { sent: true }` | `400` missing recipient for that channel | `502` gateway refused.

- [ ] **Step 1: Write the failing test**

```ts
// src/routes/__tests__/vendorSendTicket.route.test.ts
// imports as in vendorTicketRecipient.route.test.ts, plus:
//   import { SmsService } from '@services/sms.service';
//   import { EmailService } from '@services/email.service';
//   import { Event } from '@models/event.model';
// beforeEach additionally seeds an Event (as in vendorTicketPdf.route.test.ts) and:
//   smsSpy   = jest.spyOn(SmsService, 'sendTicketConfirmation').mockResolvedValue(true);
//   emailSpy = jest.spyOn(EmailService, 'sendTicketConfirmation').mockResolvedValue(true);

const send = (ticketId: string, body: any) =>
  request(app).post(`/api/tickets/${ticketId}/send`)
    .set('Authorization', `Bearer ${token}`).send(body);

it('sends this ticket by SMS to its own recipient', async () => {
  const t = await makeTicket(vendorId);
  t.customerPhone = '+26876111111'; await t.save();

  const res = await send(t.ticketId, { channel: 'sms' });

  expect(res.status).toBe(200);
  expect(res.body.data.sent).toBe(true);
  expect(smsSpy).toHaveBeenCalledTimes(1);
  const [phone, summaries] = smsSpy.mock.calls[0]!;
  expect(phone).toBe('+26876111111');
  expect(summaries).toHaveLength(1);           // ONE ticket, not the whole sale
  expect(summaries[0].startTime).toBeTruthy(); // or the SMS prints 02:00
  expect(emailSpy).not.toHaveBeenCalled();
});

it('sends by email when that channel is chosen', async () => {
  const t = await makeTicket(vendorId);
  t.customerEmail = 'thandi@example.com'; await t.save();
  const res = await send(t.ticketId, { channel: 'email' });
  expect(res.status).toBe(200);
  expect(emailSpy).toHaveBeenCalledTimes(1);
  expect(smsSpy).not.toHaveBeenCalled();
});

it('refuses SMS when the ticket has no phone, and sends nothing', async () => {
  const t = await makeTicket(vendorId); // no customerPhone
  const res = await send(t.ticketId, { channel: 'sms' });
  expect(res.status).toBe(400);
  expect(smsSpy).not.toHaveBeenCalled();
});

it('surfaces a gateway rejection as 502', async () => {
  const t = await makeTicket(vendorId);
  t.customerPhone = '+26876111111'; await t.save();
  smsSpy.mockResolvedValue(false);
  const res = await send(t.ticketId, { channel: 'sms' });
  expect(res.status).toBe(502);
});

it('refuses another vendor ticket', async () => {
  const other = await Vendor.create({
    businessName: 'Rival', email: 'rival@example.com',
    password: 'Password1!', isActive: true, isVerified: true,
  });
  const t = await makeTicket(other._id.toString());
  t.customerPhone = '+26876111111'; await t.save();
  const res = await send(t.ticketId, { channel: 'sms' });
  expect(res.status).toBe(403);
  expect(smsSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/routes/__tests__/vendorSendTicket.route.test.ts --runInBand`
Expected: FAIL — route not registered.

- [ ] **Step 3: Add the service method**

In `src/services/ticket.service.ts`:

```ts
  /**
   * Send ONE ticket to the recipient stored on that ticket. Deliberately takes
   * no recipient argument: the ticket is the single source of truth, so a
   * caller must PATCH the recipient first.
   *
   * Validates the channel against the stored contact BEFORE dispatching — an SMS
   * credit is spent either way, so the guard belongs ahead of the send.
   */
  static async sendTicketToItsRecipient(
    ticket: ITicket,
    channel: 'sms' | 'email',
  ): Promise<{ sent: boolean }> {
    const event = await Event.findById(ticket.eventId);
    if (!event) {
      throw new Error(`Event not found for ticket: ${ticket.ticketId}`);
    }

    const summaries = [{
      ticketId: ticket.ticketId,
      eventName: event.name,
      eventDate: event.eventDate.toISOString(),
      startTime: event.startTime?.toISOString(),
      venue: event.venue,
    }];

    if (channel === 'sms') {
      if (!ticket.customerPhone) {
        throw new Error('This ticket has no recipient phone number');
      }
      return { sent: await SmsService.sendTicketConfirmation(ticket.customerPhone, summaries) };
    }

    if (!ticket.customerEmail) {
      throw new Error('This ticket has no recipient email address');
    }
    return { sent: await EmailService.sendTicketConfirmation(ticket.customerEmail, summaries) };
  }
```

- [ ] **Step 4: Add the controller method**

In `src/controllers/tickets.controller.ts`:

```ts
  /** Sales: send ONE ticket to its own recipient over the chosen channel. */
  static async sendSingleTicket(req: Request, res: Response): Promise<any> {
    try {
      const ticketsUser = (req as any).ticketsUser;

      const { error, value } = Joi.object({
        channel: Joi.string().valid('sms', 'email').required(),
      }).validate(req.body);

      if (error) {
        return ApiResponseUtil.error(res, error.details[0]?.message || 'Validation error', 400);
      }

      const ticket = await TicketService.resolveVendorTicket(
        req.params['ticketId'] as string,
        ticketsUser.vendorId as string,
        ticketsUser.isSuperAdmin || false,
      );

      const { sent } = await TicketService.sendTicketToItsRecipient(ticket, value.channel);
      if (!sent) {
        return ApiResponseUtil.error(res, 'Gateway did not accept the message', 502);
      }
      return ApiResponseUtil.success(res, { sent }, 'Ticket sent');
    } catch (err: any) {
      const msg = err?.message || '';
      if (/not authorized/i.test(msg)) return ApiResponseUtil.error(res, 'You are not allowed to access this ticket', 403);
      if (/no recipient/i.test(msg)) return ApiResponseUtil.error(res, msg, 400);
      if (/event not found/i.test(msg)) return ApiResponseUtil.error(res, 'Internal error: event data missing for this ticket', 500);
      if (/not found/i.test(msg)) return ApiResponseUtil.error(res, 'Ticket not found', 404);
      console.error('Send single ticket error:', err);
      return ApiResponseUtil.error(res, msg || 'Failed to send ticket');
    }
  }
```

- [ ] **Step 5: Register the route**

```ts
router.post(
  '/:ticketId/send',
  requireTicketsPermission(TicketsPermission.SELL_TICKETS),
  TicketsController.sendSingleTicket
);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx jest src/routes/__tests__/vendorSendTicket.route.test.ts --runInBand`
Expected: PASS (5 tests)

- [ ] **Step 6b: Thread the ticket PDF link into the message body**

The spec requires both channels to send **code + link**, but no message body
carries a link today — `SmsService` ends with the fixed string
`'View anytime in your Carrot profile.'`. `TicketSummary` has no URL field, so
this needs a change to the SHARED sender used by every rail. Keep it additive:

In `src/services/sms.service.ts`, add the optional field to `TicketSummary`:

```ts
export interface TicketSummary {
  ticketId: string;
  eventName: string;
  eventDate: string;
  startTime?: string;
  venue: string;
  /** Direct link to this ticket's PDF. Optional: existing callers omit it and
   *  their message bodies are byte-identical to before. */
  pdfUrl?: string;
}
```

and in the single-ticket branch of `sendTicketConfirmation`, append it only when present:

```ts
    if (tickets.length === 1) {
      body =
        `🎫 ${first.eventName} ticket confirmed!\n` +
        `Code: ${groupTicketCode(first.ticketId)}\n` +
        `${dateShort} • ${first.venue}\n` +
        `Show this code at entry.` +
        (first.pdfUrl ? `\nTicket: ${first.pdfUrl}` : '') +
        ` ${profileNote}`;
```

Mirror the same optional append in `EmailService.sendTicketConfirmation`.

Then in `TicketService.sendTicketToItsRecipient`, resolve the link before building
the summary:

```ts
    // The R2-cached artifact is idempotent — first call renders and uploads,
    // later calls return the same URL.
    const pdf = await TicketPdfService.ensureTicketPdf(ticket);

    const summaries = [{
      ticketId: ticket.ticketId,
      eventName: event.name,
      eventDate: event.eventDate.toISOString(),
      startTime: event.startTime?.toISOString(),
      venue: event.venue,
      ...(pdf.pdfUrl ? { pdfUrl: pdf.pdfUrl } : {}),
    }];
```

Add a test to `vendorSendTicket.route.test.ts`:

```ts
it('includes the ticket PDF link in the message', async () => {
  jest.spyOn(TicketPdfService, 'ensureTicketPdf')
    .mockResolvedValue({ status: 'ready', pdfUrl: 'https://cdn.example/t.pdf' } as any);
  const t = await makeTicket(vendorId);
  t.customerPhone = '+26876111111'; await t.save();

  await send(t.ticketId, { channel: 'sms' });

  const [, summaries] = smsSpy.mock.calls[0]!;
  expect(summaries[0].pdfUrl).toBe('https://cdn.example/t.pdf');
});
```

Then confirm the shared sender did not change for existing callers:

Run: `npx jest src/services/__tests__/email.service.test.ts src/services/__tests__/smsTicketCode.test.ts src/services/__tests__/resellerSale.service.test.ts --runInBand`
Expected: PASS — no existing caller passes `pdfUrl`, so every current body is unchanged.

- [ ] **Step 7: Full API regression in batches**

Run, as two commands (this machine OOMs on the whole suite at once):
```bash
npx jest --runInBand src/routes/__tests__/vendorSellCart.route.test.ts src/routes/__tests__/vendorSellRecipients.route.test.ts src/routes/__tests__/vendorSendSaleSms.route.test.ts src/routes/__tests__/vendorSendTicket.route.test.ts
npx jest --runInBand src/routes/__tests__/vendorTicketPdf.route.test.ts src/routes/__tests__/vendorTicketBundle.route.test.ts src/routes/__tests__/vendorTicketRecipient.route.test.ts src/services/__tests__/resellerSale.service.test.ts
```
Expected: PASS. Confirm the printed `Tests:` summary line appears — a crashed run can exit 0 with no summary.

- [ ] **Step 8: Compile and commit**

```bash
npm run build
git add src/services/ticket.service.ts src/controllers/tickets.controller.ts src/routes/tickets.route.ts src/routes/__tests__/vendorSendTicket.route.test.ts
git commit -m "feat(tickets): send one ticket to its own recipient by SMS or email"
```

- [ ] **Step 9: Deploy the API and WAIT**

```bash
git push origin HEAD:main
```
Then confirm before starting Task 6: the Cloud Build run for this SHA is SUCCESS, a new `carrot-tickets-api` revision holds 100% traffic, and the tag for this commit in Artifact Registry resolves to the digest on that revision. Do NOT verify by probing the route for a 401 — auth middleware runs before routing, so every path returns 401 anonymously.

---

## Part 2 — Dashboard

### Task 6: API client + types

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/lib/api.ts` (in `sales = { ... }` and a new `ticketDocs` group)
- Test: `src/lib/__tests__/ticketRecipientApi.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2–5 endpoints.
- Produces:
  - `TicketRecipient = { name?: string; phone?: string; email?: string }`
  - `SendChannel = 'sms' | 'email'`
  - `apiClient.sales.setTicketRecipient(ticketId: string, r: TicketRecipient): Promise<{ ticket: {...} }>`
  - `apiClient.sales.sendTicket(ticketId: string, channel: SendChannel): Promise<{ sent: boolean }>`
  - `apiClient.sales.ticketPdfBytes(ticketId: string): Promise<Blob>`
  - `apiClient.sales.ticketBundlePdf(ticketIds: string[]): Promise<Blob>`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/ticketRecipientApi.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient } from '@/lib/api';

const okJson = (data: unknown) => Promise.resolve({
  ok: true, status: 200,
  json: () => Promise.resolve({ success: true, data }),
} as Response);

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('per-ticket API client', () => {
  it('PATCHes a recipient to the ticket route', async () => {
    vi.mocked(fetch).mockReturnValue(okJson({ ticket: { ticketId: 'TKT-1' } }));
    await apiClient.sales.setTicketRecipient('TKT-1', { name: 'Thandi', phone: '+26876111111' });

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain('/tickets/TKT-1/recipient');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: 'Thandi', phone: '+26876111111' });
  });

  it('POSTs the chosen channel to the send route', async () => {
    vi.mocked(fetch).mockReturnValue(okJson({ sent: true }));
    const res = await apiClient.sales.sendTicket('TKT-1', 'email');

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain('/tickets/TKT-1/send');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ channel: 'email' });
    expect(res.sent).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/ticketRecipientApi.test.ts`
Expected: FAIL — `setTicketRecipient is not a function`.

- [ ] **Step 3: Add the types**

In `src/types/index.ts`, beside `SellTicketsResponse`:

```ts
/** One ticket's own recipient. Every field optional — a partially-filled row is
 *  valid until the chosen channel needs its contact field. */
export interface TicketRecipient {
  name?: string;
  phone?: string;
  email?: string;
}

export type SendChannel = 'sms' | 'email';
```

And widen the sell request so the till can pass them:

```ts
export interface SellTicketsRequest {
  eventId: string;
  items: Array<{
    ticketTypeId: string;
    quantity: number;
    /** Sparse, applied in order. Absent entries fall back to the buyer. */
    recipients?: TicketRecipient[];
  }>;
  customerName: string;
  customerPhone: string;
  paymentMethod: PaymentMethodValue;
  walletCardNumber?: string;
  walletPin?: string;
}
```

- [ ] **Step 4: Add the client methods**

In `src/lib/api.ts`, inside `sales = { ... }`:

```ts
    setTicketRecipient: async (
      ticketId: string,
      recipient: TicketRecipient,
    ): Promise<{ ticket: { ticketId: string; customerName?: string; customerPhone?: string; customerEmail?: string } }> => {
      return this.request(`/tickets/${ticketId}/recipient`, {
        method: 'PATCH',
        body: JSON.stringify(recipient),
      });
    },

    sendTicket: async (ticketId: string, channel: SendChannel): Promise<{ sent: boolean }> => {
      return this.request(`/tickets/${ticketId}/send`, {
        method: 'POST',
        body: JSON.stringify({ channel }),
      });
    },
```

`this.request` parses JSON, so the two PDF calls need their own fetch that returns bytes. Add a sibling group after `sales`:

```ts
  // PDF endpoints return bytes, not JSON, so they bypass `request` (which
  // unwraps a JSON envelope) and read the body as a Blob.
  ticketDocs = {
    ticketPdfBytes: async (ticketId: string): Promise<Blob> =>
      this.fetchPdf(`/tickets/${ticketId}/pdf/download`, { method: 'GET' }),

    ticketBundlePdf: async (ticketIds: string[]): Promise<Blob> =>
      this.fetchPdf('/tickets/pdf-bundle', {
        method: 'POST',
        body: JSON.stringify({ ticketIds }),
      }),
  };

  private async fetchPdf(endpoint: string, options: RequestInit): Promise<Blob> {
    const token = this.getToken();
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(APP_API_KEY ? { 'x-api-key': APP_API_KEY } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers as Record<string, string>),
      },
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
      throw new Error(err.message || `HTTP ${response.status}`);
    }
    return response.blob();
  }
```

Import `TicketRecipient` and `SendChannel` in `api.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/ticketRecipientApi.test.ts && npx tsc --noEmit`
Expected: PASS, TSC clean

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/lib/api.ts src/lib/__tests__/ticketRecipientApi.test.ts
git commit -m "feat(api-client): per-ticket recipient, send and PDF endpoints"
```

---

### Task 7: Per-ticket rows in the success dialog

**Files:**
- Create: `src/components/TicketRecipientRow.tsx`
- Modify: `src/components/TicketSuccessDialog.tsx`
- Test: `src/components/__tests__/TicketRecipientRow.test.tsx` (create)
- Test: `src/components/__tests__/TicketSuccessDialogPanel.test.tsx` (create)

**Interfaces:**
- Consumes: `TicketRecipient`, `SendChannel` (Task 6).
- Produces: `TicketSuccessDialogProps.perTicket?: { setRecipient(ticketId, r): Promise<unknown>; send(ticketId, channel): Promise<{ sent: boolean }>; downloadOne(ticketId): Promise<void>; }` — **optional**; when absent the dialog renders exactly as before.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/__tests__/TicketRecipientRow.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TicketRecipientRow } from '@/components/TicketRecipientRow';

const base = {
  ticketId: 'TKT-1',
  onSetRecipient: vi.fn().mockResolvedValue({}),
  onSend: vi.fn().mockResolvedValue({ sent: true }),
  onDownload: vi.fn().mockResolvedValue(undefined),
};

describe('TicketRecipientRow', () => {
  it('saves the recipient before sending', async () => {
    const calls: string[] = [];
    render(<TicketRecipientRow {...base}
      onSetRecipient={vi.fn(async () => { calls.push('save'); return {}; })}
      onSend={vi.fn(async () => { calls.push('send'); return { sent: true }; })} />);

    fireEvent.change(screen.getByLabelText('Recipient name for TKT-1'), { target: { value: 'Thandi' } });
    fireEvent.change(screen.getByLabelText('Recipient contact for TKT-1'), { target: { value: '+26876111111' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(calls).toEqual(['save', 'send']));
    expect(await screen.findByText(/sent/i)).toBeTruthy();
  });

  it('shows the failure reason on that row and does not claim success', async () => {
    render(<TicketRecipientRow {...base}
      onSend={vi.fn().mockRejectedValue(new Error('Gateway did not accept the message'))} />);

    fireEvent.change(screen.getByLabelText('Recipient contact for TKT-1'), { target: { value: '+26876111111' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(await screen.findByText(/gateway did not accept/i)).toBeTruthy();
    expect(screen.queryByText(/^sent$/i)).toBeNull();
  });

  it('refuses to send SMS with no phone, before calling the API', async () => {
    const onSend = vi.fn();
    render(<TicketRecipientRow {...base} onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(screen.getByText(/add a phone number/i)).toBeTruthy());
    expect(onSend).not.toHaveBeenCalled();
  });
});
```

```tsx
// src/components/__tests__/TicketSuccessDialogPanel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TicketSuccessDialog } from '@/components/TicketSuccessDialog';
import type { SaleData } from '@/lib/saleData';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const saleData: SaleData = {
  saleId: 's1', eventName: 'Gig', ticketTypeName: '2 × General',
  customerName: 'Walk-up', customerPhone: '+26878422613',
  quantity: 2, totalAmount: 200, paymentMethod: 'Cash',
  operatorName: 'Box Office', ticketIds: ['TKT-1', 'TKT-2'],
};

const props = {
  open: true, onOpenChange: vi.fn(), saleData,
  sendSms: vi.fn().mockResolvedValue({ sent: true }),
};

describe('TicketSuccessDialog per-ticket panel', () => {
  it('renders one row per ticket when perTicket is supplied', () => {
    render(<TicketSuccessDialog {...props} perTicket={{
      setRecipient: vi.fn().mockResolvedValue({}),
      send: vi.fn().mockResolvedValue({ sent: true }),
      downloadOne: vi.fn().mockResolvedValue(undefined),
      downloadBundle: vi.fn().mockResolvedValue(new Blob()),
      fetchOneBlob: vi.fn().mockResolvedValue(new Blob()),
    }} />);
    expect(screen.getByLabelText('Recipient name for TKT-1')).toBeTruthy();
    expect(screen.getByLabelText('Recipient name for TKT-2')).toBeTruthy();
  });

  // Pins the reseller POS, which passes no perTicket prop.
  it('renders exactly as before when perTicket is omitted', () => {
    render(<TicketSuccessDialog {...props} />);
    expect(screen.queryByLabelText('Recipient name for TKT-1')).toBeNull();
    expect(screen.getByText('TKT-1')).toBeTruthy(); // plain chip, as today
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/__tests__/TicketRecipientRow.test.tsx src/components/__tests__/TicketSuccessDialogPanel.test.tsx`
Expected: FAIL — `TicketRecipientRow` does not exist.

- [ ] **Step 3: Create the row component**

```tsx
// src/components/TicketRecipientRow.tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Download, Send } from 'lucide-react';
import type { SendChannel, TicketRecipient } from '@/types';

interface Props {
  ticketId: string;
  onSetRecipient: (ticketId: string, r: TicketRecipient) => Promise<unknown>;
  onSend: (ticketId: string, channel: SendChannel) => Promise<{ sent: boolean }>;
  onDownload: (ticketId: string) => Promise<void>;
}

type RowState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'failed'; reason: string };

export function TicketRecipientRow({ ticketId, onSetRecipient, onSend, onDownload }: Props) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [channel, setChannel] = useState<SendChannel>('sms');
  const [state, setState] = useState<RowState>({ kind: 'idle' });
  const [downloading, setDownloading] = useState(false);

  const handleSend = async () => {
    // Guard BEFORE the API call: a send spends a credit either way.
    if (channel === 'sms' && !contact.trim()) {
      setState({ kind: 'failed', reason: 'Add a phone number to send by SMS' });
      return;
    }
    if (channel === 'email' && !contact.includes('@')) {
      setState({ kind: 'failed', reason: 'Add an email address to send by email' });
      return;
    }

    setState({ kind: 'sending' });
    try {
      // The ticket is the single source of truth, so persist first, then send.
      await onSetRecipient(ticketId, {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(channel === 'sms' ? { phone: contact.trim() } : { email: contact.trim() }),
      });
      const { sent } = await onSend(ticketId, channel);
      setState(sent ? { kind: 'sent' } : { kind: 'failed', reason: 'Not accepted by the gateway' });
    } catch (err) {
      setState({ kind: 'failed', reason: err instanceof Error ? err.message : 'Failed to send' });
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      await onDownload(ticketId);
    } catch (err) {
      setState({ kind: 'failed', reason: err instanceof Error ? err.message : 'Download failed' });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 py-2">
      <span className="font-mono text-xs w-32 shrink-0">{ticketId}</span>

      <Input
        aria-label={`Recipient name for ${ticketId}`}
        placeholder="Name"
        className="h-9 w-32"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <Input
        aria-label={`Recipient contact for ${ticketId}`}
        placeholder={channel === 'sms' ? '7612 3456' : 'name@example.com'}
        className="h-9 w-44"
        value={contact}
        onChange={(e) => setContact(e.target.value)}
      />

      <select
        aria-label={`Send channel for ${ticketId}`}
        className="h-9 rounded-md border border-slate-300 px-2 text-sm"
        value={channel}
        onChange={(e) => { setChannel(e.target.value as SendChannel); setState({ kind: 'idle' }); }}
      >
        <option value="sms">SMS</option>
        <option value="email">Email</option>
      </select>

      <Button size="sm" onClick={handleSend} disabled={state.kind === 'sending'}>
        {state.kind === 'sending'
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <Send className="h-4 w-4" />}
        <span className="ml-1">Send</span>
      </Button>

      <Button size="sm" variant="outline" onClick={handleDownload} disabled={downloading}>
        {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
      </Button>

      {state.kind === 'sent' && <span className="text-xs font-medium text-green-600">Sent</span>}
      {state.kind === 'failed' && <span className="text-xs font-medium text-red-600">{state.reason}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Wire the opt-in panel into the dialog**

In `src/components/TicketSuccessDialog.tsx`, extend the props:

```ts
  /** Supplied only by surfaces that support per-ticket recipients (the organizer
   *  portal). Omitted by the reseller POS, which then renders today's dialog. */
  perTicket?: {
    setRecipient: (ticketId: string, r: TicketRecipient) => Promise<unknown>;
    send: (ticketId: string, channel: SendChannel) => Promise<{ sent: boolean }>;
    downloadOne: (ticketId: string) => Promise<void>;
    // Declared here, consumed in Task 8 — defining the full shape up front keeps
    // Task 7's tests valid once the bulk-download buttons land.
    downloadBundle: (ticketIds: string[]) => Promise<Blob>;
    fetchOneBlob: (ticketId: string) => Promise<Blob>;
  };
```

Add `const MAX_INLINE_RECIPIENT_ROWS = 20;` at module scope, and replace the ticket-ID chip block with:

```tsx
              <div className="border-t border-orange-200 pt-4">
                <p className="text-sm text-slate-600 font-medium mb-2">Ticket ID(s)</p>
                {perTicket && saleData.ticketIds.length <= MAX_INLINE_RECIPIENT_ROWS ? (
                  <div>
                    {saleData.ticketIds.map((id) => (
                      <TicketRecipientRow
                        key={id}
                        ticketId={id}
                        onSetRecipient={perTicket.setRecipient}
                        onSend={perTicket.send}
                        onDownload={perTicket.downloadOne}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {saleData.ticketIds.map((id) => (
                      <span key={id} className="px-3 py-1 bg-white border border-orange-300 rounded-md text-sm font-mono">
                        {id}
                      </span>
                    ))}
                  </div>
                )}
              </div>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/__tests__/TicketRecipientRow.test.tsx src/components/__tests__/TicketSuccessDialogPanel.test.tsx`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/components/TicketRecipientRow.tsx src/components/TicketSuccessDialog.tsx src/components/__tests__/TicketRecipientRow.test.tsx src/components/__tests__/TicketSuccessDialogPanel.test.tsx
git commit -m "feat(dialog): opt-in per-ticket recipient rows"
```

---

### Task 8: Download all — PDF and ZIP

**Files:**
- Create: `src/lib/ticketDownloads.ts`
- Modify: `src/components/TicketSuccessDialog.tsx` (header buttons)
- Test: `src/lib/__tests__/ticketDownloads.test.ts` (create)
- Modify: `package.json` (add `jszip`)

**Interfaces:**
- Consumes: `apiClient.ticketDocs.*` (Task 6).
- Produces: `saveBlob(blob: Blob, filename: string): void`; `buildTicketsZip(ticketIds: string[], fetchOne: (id: string) => Promise<Blob>): Promise<Blob>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/ticketDownloads.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildTicketsZip } from '@/lib/ticketDownloads';

describe('buildTicketsZip', () => {
  it('includes one entry per ticket', async () => {
    const fetchOne = vi.fn(async (id: string) => new Blob([`pdf-${id}`], { type: 'application/pdf' }));
    const zip = await buildTicketsZip(['TKT-1', 'TKT-2'], fetchOne);
    expect(zip.size).toBeGreaterThan(0);
    expect(fetchOne).toHaveBeenCalledTimes(2);
  });

  // A ZIP quietly holding 4 of 5 tickets means someone finds out at the gate.
  it('fails the whole zip when any ticket fails', async () => {
    const fetchOne = vi.fn(async (id: string) => {
      if (id === 'TKT-2') throw new Error('403');
      return new Blob(['pdf'], { type: 'application/pdf' });
    });
    await expect(buildTicketsZip(['TKT-1', 'TKT-2'], fetchOne)).rejects.toThrow(/TKT-2/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/ticketDownloads.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add jszip**

```bash
npm install jszip@^3.10.1
```

- [ ] **Step 4: Write the module**

```ts
// src/lib/ticketDownloads.ts
import JSZip from 'jszip';

/** Hand a generated file to the browser. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Zip one PDF per ticket.
 *
 * All-or-nothing on purpose: a zip silently containing 4 of 5 tickets means the
 * organizer hands out four and discovers the fifth at the gate. One failure
 * fails the download, naming the ticket that broke.
 */
export async function buildTicketsZip(
  ticketIds: string[],
  fetchOne: (ticketId: string) => Promise<Blob>,
): Promise<Blob> {
  const zip = new JSZip();
  for (const ticketId of ticketIds) {
    try {
      zip.file(`${ticketId}.pdf`, await fetchOne(ticketId));
    } catch (err) {
      throw new Error(`Could not fetch ${ticketId}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
  return zip.generateAsync({ type: 'blob' });
}
```

- [ ] **Step 5: Add the header buttons**

In `TicketSuccessDialog.tsx`, inside the `perTicket &&` branch, above the rows:

```tsx
                    <div className="flex flex-wrap gap-2 pb-2">
                      <Button size="sm" variant="outline" disabled={bundling} onClick={handleDownloadAllPdf}>
                        {bundling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        <span className="ml-1">Download all (PDF)</span>
                      </Button>
                      <Button size="sm" variant="outline" disabled={zipping} onClick={handleDownloadAllZip}>
                        {zipping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        <span className="ml-1">Download all (ZIP)</span>
                      </Button>
                    </div>
```

with handlers in the component:

```tsx
  const [bundling, setBundling] = useState(false);
  const [zipping, setZipping] = useState(false);

  const handleDownloadAllPdf = async () => {
    if (!perTicket) return;
    setBundling(true);
    try {
      saveBlob(await perTicket.downloadBundle(saleData.ticketIds), 'tickets.pdf');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not build the ticket PDF');
    } finally {
      setBundling(false);
    }
  };

  const handleDownloadAllZip = async () => {
    if (!perTicket) return;
    setZipping(true);
    try {
      const zip = await buildTicketsZip(saleData.ticketIds, perTicket.fetchOneBlob);
      saveBlob(zip, 'tickets.zip');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not build the ZIP');
    } finally {
      setZipping(false);
    }
  };
```

`perTicket` already declares `downloadBundle` and `fetchOneBlob` from Task 7 — no interface change here.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/ticketDownloads.test.ts && npx tsc --noEmit`
Expected: PASS, TSC clean

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lib/ticketDownloads.ts src/lib/__tests__/ticketDownloads.test.ts src/components/TicketSuccessDialog.tsx
git commit -m "feat(dialog): download all tickets as one PDF or a ZIP"
```

---

### Task 9: Assign recipients at the till

**Files:**
- Modify: `src/pages/TicketSalesPage.tsx`
- Test: `src/pages/__tests__/TicketSalesPage.test.tsx` (extend)

**Interfaces:**
- Consumes: `TicketRecipient` (Task 6).
- Produces: the sell request's `items[]` carry `recipients` when the optional section is filled.

- [ ] **Step 1: Write the failing test**

Append to `src/pages/__tests__/TicketSalesPage.test.tsx`:

```tsx
  it('sends per-ticket recipients when the optional section is filled', async () => {
    renderPage();
    await chooseEvent();

    fireEvent.change(await screen.findByLabelText('Quantity for General'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /assign tickets to individual people/i }));

    fireEvent.change(screen.getByLabelText('Recipient 1 name'), { target: { value: 'Thandi' } });
    fireEvent.change(screen.getByLabelText('Recipient 1 phone'), { target: { value: '76111111' } });

    fireEvent.change(screen.getByPlaceholderText(/full name/i), { target: { value: 'Walk-up' } });
    fireEvent.change(screen.getByPlaceholderText('78422613'), { target: { value: '78422613' } });
    fireEvent.click(screen.getByRole('button', { name: /complete sale|sell/i }));

    await waitFor(() => expect(apiClient.sales.sellTickets).toHaveBeenCalled());
    const body = vi.mocked(apiClient.sales.sellTickets).mock.calls[0]![0] as any;
    expect(body.items[0].recipients[0]).toMatchObject({ name: 'Thandi' });
  });

  it('sends no recipients key when the section is untouched', async () => {
    renderPage();
    await chooseEvent();
    fireEvent.change(await screen.findByLabelText('Quantity for General'), { target: { value: '2' } });
    fireEvent.change(screen.getByPlaceholderText(/full name/i), { target: { value: 'Walk-up' } });
    fireEvent.change(screen.getByPlaceholderText('78422613'), { target: { value: '78422613' } });
    fireEvent.click(screen.getByRole('button', { name: /complete sale|sell/i }));

    await waitFor(() => expect(apiClient.sales.sellTickets).toHaveBeenCalled());
    const body = vi.mocked(apiClient.sales.sellTickets).mock.calls[0]![0] as any;
    expect(body.items[0].recipients).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pages/__tests__/TicketSalesPage.test.tsx`
Expected: FAIL — the toggle button does not exist.

- [ ] **Step 3: Implement the optional section**

In `TicketSalesPage.tsx` add state and a collapsible block rendered when `cartQuantity > 0`:

```tsx
  const [assigning, setAssigning] = useState(false);
  // Keyed by "<ticketTypeId>:<index>" so a cart change cannot shuffle entries.
  const [recipients, setRecipients] = useState<Record<string, TicketRecipient>>({});

  const recipientsForLine = (ticketTypeId: string, quantity: number): TicketRecipient[] | undefined => {
    const entries = Array.from({ length: quantity }, (_, i) => recipients[`${ticketTypeId}:${i}`] ?? {});
    // Trailing blanks carry no meaning — trim so an untouched section sends nothing.
    while (entries.length && Object.keys(entries[entries.length - 1]!).length === 0) entries.pop();
    return entries.length ? entries : undefined;
  };
```

Render, beneath the cart:

```tsx
          {cartQuantity > 0 && (
            <div className="space-y-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setAssigning((v) => !v)}>
                Assign tickets to individual people (optional)
              </Button>
              {assigning && cartLines.flatMap((l) =>
                Array.from({ length: l.quantity }, (_, i) => {
                  const key = `${l.ticketTypeId}:${i}`;
                  const n = i + 1;
                  return (
                    <div key={key} className="flex gap-2">
                      <Input
                        aria-label={`Recipient ${n} name`}
                        placeholder={`${l.tier.name} #${n} name`}
                        value={recipients[key]?.name ?? ''}
                        onChange={(e) => setRecipients((r) => ({ ...r, [key]: { ...r[key], name: e.target.value } }))}
                      />
                      <Input
                        aria-label={`Recipient ${n} phone`}
                        placeholder="7612 3456"
                        value={recipients[key]?.phone ?? ''}
                        onChange={(e) => setRecipients((r) => ({ ...r, [key]: { ...r[key], phone: e.target.value } }))}
                      />
                    </div>
                  );
                })
              )}
            </div>
          )}
```

And in `handleSubmit`, build each item with its recipients:

```tsx
      items: cartLines.map((l) => ({
        ticketTypeId: l.ticketTypeId,
        quantity: l.quantity,
        ...(recipientsForLine(l.ticketTypeId, l.quantity)
          ? { recipients: recipientsForLine(l.ticketTypeId, l.quantity) }
          : {}),
      })),
```

Reset `setRecipients({})` and `setAssigning(false)` alongside `setCart({})` in `onSuccess`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/pages/__tests__/TicketSalesPage.test.tsx`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add src/pages/TicketSalesPage.tsx src/pages/__tests__/TicketSalesPage.test.tsx
git commit -m "feat(sell): optional per-ticket recipient assignment at the till"
```

---

### Task 10: Wire the organizer page and ship

**Files:**
- Modify: `src/pages/TicketSalesPage.tsx` (pass `perTicket`)
- Test: `src/pages/__tests__/TicketSalesPage.test.tsx` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces: the organizer dialog is fully wired; the reseller POS remains unchanged.

- [ ] **Step 1: Write the failing test**

```tsx
  it('gives the dialog the organizer per-ticket rails', async () => {
    renderPage();
    await chooseEvent();
    fireEvent.change(await screen.findByLabelText('Quantity for General'), { target: { value: '1' } });
    fireEvent.change(screen.getByPlaceholderText(/full name/i), { target: { value: 'Walk-up' } });
    fireEvent.change(screen.getByPlaceholderText('78422613'), { target: { value: '78422613' } });
    fireEvent.click(screen.getByRole('button', { name: /complete sale|sell/i }));

    await waitFor(() => expect(dialogProps.length).toBeGreaterThan(0));
    const p = dialogProps[dialogProps.length - 1]!;
    expect(p.perTicket.setRecipient).toBe(apiClient.sales.setTicketRecipient);
    expect(p.perTicket.send).toBe(apiClient.sales.sendTicket);
  });
```

Add `setTicketRecipient: vi.fn(), sendTicket: vi.fn()` to the file's `apiClient.sales` mock, and `ticketDocs: { ticketPdfBytes: vi.fn(), ticketBundlePdf: vi.fn() }` to the mocked client.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pages/__tests__/TicketSalesPage.test.tsx`
Expected: FAIL — `perTicket` is undefined.

- [ ] **Step 3: Pass the rails**

```tsx
        <TicketSuccessDialog
          open={successDialogOpen}
          onOpenChange={setSuccessDialogOpen}
          saleData={saleData}
          sendSms={apiClient.sales.sendSaleSms}
          perTicket={{
            setRecipient: apiClient.sales.setTicketRecipient,
            send: apiClient.sales.sendTicket,
            downloadOne: async (ticketId) =>
              saveBlob(await apiClient.ticketDocs.ticketPdfBytes(ticketId), `${ticketId}.pdf`),
            downloadBundle: (ticketIds) => apiClient.ticketDocs.ticketBundlePdf(ticketIds),
            fetchOneBlob: (ticketId) => apiClient.ticketDocs.ticketPdfBytes(ticketId),
          }}
        />
```

- [ ] **Step 4: Full dashboard verification**

```bash
npx vitest run && npx tsc --noEmit && npm run build
```
Expected: all suites PASS, TSC clean, build succeeds.

- [ ] **Step 5: Commit and deploy**

```bash
git add src/pages/TicketSalesPage.tsx src/pages/__tests__/TicketSalesPage.test.tsx
git commit -m "feat(sell): wire the organizer per-ticket rails into the success dialog"
git push origin HEAD:main
```

- [ ] **Step 6: Verify the deploy**

Poll the Cloudflare Pages project `keshless-tickets-admin` (contracts account) until the production deployment for this commit reports `deploy success`, then confirm the served bundle contains the new code — fetch `https://manage.carrottickets.com/`, read the `assets/index-*.js` name, and grep that file for `Assign tickets to individual people`. A changed hash alone is not proof.

---

## Manual verification (after both deploys)

The automated tests never touch a real gateway. Do this once on production:

1. Sell 2 tickets at the box office to a walk-up buyer.
2. In the dialog, give ticket 1 your own number with channel SMS and send → the SMS arrives, and the event time in it reads correctly (not 02:00).
3. Give ticket 2 an email address with channel Email and send → the mail arrives with a working PDF link.
4. Download ticket 1 alone, then "Download all (PDF)", then "Download all (ZIP)" → 1 page, 2 pages, 2 files.
5. Scan ticket 1 at the gate, then try to reassign it in a fresh sale's dialog → refused with the 409 message.
