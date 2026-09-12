import { Request, Response } from 'express';
import { Ticket } from '@models/ticket.model';
import { ITicket, TicketPdfStatus } from '@interfaces/ticket.interface';
import { TicketPdfService } from '@services/ticketPdf.service';
import { TicketService } from '@services/ticket.service';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { resolveBuyerFromRequest } from '@utils/buyerRequest.util';
import { buyerTicketOr } from '@utils/ticketHolder.util';
import { normalizePhone } from '@utils/phone.util';

const EVENT_POPULATE_FIELDS = 'name venue eventDate startTime endTime posterUrl';
// Guards a pathological request (e.g. a hand-crafted body) from asking for an
// unbounded number of pages in one PDF.
const MAX_BUNDLE_TICKETS = 100;

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'tickets';
}

function sendPdf(res: Response, buffer: Buffer, filename: string): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

type BundleTicketIdsValidation =
  | { ok: true; ticketIds: string[] }
  | { ok: false; message: string };

/**
 * Shared shape check for a `{ ticketIds: string[] }` bundle request body, used
 * by both the buyer (`downloadTicketsBundle`) and vendor
 * (`downloadVendorTicketsBundle`) bundle endpoints so the cap and the
 * validation rule can't drift between the two copies. Runs before either
 * route touches the database — a 1000-element list must still cost zero DB
 * lookups.
 */
function validateBundleTicketIds(ticketIds: unknown): BundleTicketIdsValidation {
  if (!Array.isArray(ticketIds) || ticketIds.length === 0 || !ticketIds.every((id) => typeof id === 'string')) {
    return { ok: false, message: 'ticketIds must be a non-empty array of ticket ids' };
  }
  if (ticketIds.length > MAX_BUNDLE_TICKETS) {
    return { ok: false, message: `Cannot bundle more than ${MAX_BUNDLE_TICKETS} tickets at once` };
  }
  return { ok: true, ticketIds };
}

/**
 * Two families of ticket-PDF endpoint share this controller:
 *
 *  - downloadTicketPdf / downloadTicketsBundle — the buyer "Download" action
 *    behind My Profile > Tickets on the website. Rendered fresh per request
 *    and streamed back as PDF bytes. Buyer-owned only: a ticket (or every
 *    ticket in a bundle request) must belong to the signed-in buyer (matched
 *    by buyerId/phone/email, the same `buyerTicketOr` used by /my-tickets) —
 *    otherwise one buyer could download another's QR code.
 *
 *  - getTicketPdf — the SHAREABLE, R2-cached PDF used by the service-auth
 *    surfaces (Keshless user-app via the keshless-api proxy, and the
 *    dashboard's vendor JWT). Returns a status envelope with a URL rather
 *    than bytes, so the same artifact can be shared and re-fetched.
 */
export class TicketPdfController {
  /** GET /api/public/tickets/:ticketId/pdf — one ticket as a downloadable PDF. */
  static async downloadTicketPdf(req: Request, res: Response): Promise<any> {
    try {
      const ticketId = req.params['ticketId'];
      if (!ticketId) {
        return ApiResponseUtil.badRequest(res, 'Ticket id is required');
      }

      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to download your ticket');
      }

      const ticket = await Ticket.findOne({ ticketId, $or: buyerTicketOr(buyer) })
        .populate('eventId', EVENT_POPULATE_FIELDS);
      if (!ticket) {
        return ApiResponseUtil.notFound(res, 'Ticket not found');
      }

      const buffer = await TicketPdfService.buildTicketPdfBuffer(ticket);
      sendPdf(res, buffer, `${sanitizeFilenamePart(ticket.ticketId)}.pdf`);
    } catch (error: any) {
      console.error('Download ticket PDF error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to generate ticket PDF');
    }
  }

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

  /**
   * POST /api/tickets/pdf-bundle — several of THIS vendor's tickets as one
   * PDF. Mirrors downloadVendorTicketPdf's ownership check but for a list.
   * Every ticket is resolved + authorised BEFORE any rendering starts: a
   * bundle containing one foreign ticket must render nothing at all, since
   * rendering first and rejecting after would still have generated (and
   * risked leaking) another organizer's QR codes.
   */
  static async downloadVendorTicketsBundle(req: Request, res: Response): Promise<any> {
    try {
      const validation = validateBundleTicketIds(req.body?.ticketIds);
      if (!validation.ok) {
        return ApiResponseUtil.badRequest(res, validation.message);
      }
      const { ticketIds } = validation;

      const ticketsUser = (req as any).ticketsUser || {};
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

  /** POST /api/public/tickets/pdf-bundle — several tickets as ONE downloadable PDF. */
  static async downloadTicketsBundle(req: Request, res: Response): Promise<any> {
    try {
      const validation = validateBundleTicketIds(req.body?.ticketIds);
      if (!validation.ok) {
        return ApiResponseUtil.badRequest(res, validation.message);
      }
      const { ticketIds } = validation;

      const buyer = await resolveBuyerFromRequest(req);
      if (!buyer) {
        return ApiResponseUtil.unauthorized(res, 'Please sign in to download your tickets');
      }

      const tickets = await Ticket.find({ ticketId: { $in: ticketIds }, $or: buyerTicketOr(buyer) })
        .populate('eventId', EVENT_POPULATE_FIELDS);

      // Every requested id must resolve to a ticket the buyer owns — a
      // partial match likely means a stale list or another buyer's ticket
      // snuck into the request, so fail loudly rather than silently drop it.
      if (tickets.length !== ticketIds.length) {
        return ApiResponseUtil.notFound(res, 'One or more tickets were not found');
      }

      // Preserve the order the caller asked for.
      const byId = new Map(tickets.map((t) => [t.ticketId, t]));
      const ordered: ITicket[] = ticketIds.map((id) => byId.get(id)!);

      const buffer = await TicketPdfService.buildBundlePdfBuffer(ordered);
      const firstEvent: any = ordered[0]?.eventId;
      const sameEvent = ordered.every((t: any) => t.eventId?._id?.toString?.() === firstEvent?._id?.toString?.());
      const filenameBase = sameEvent && firstEvent?.name ? firstEvent.name : 'carrot-tickets';
      sendPdf(res, buffer, `${sanitizeFilenamePart(filenameBase)}-tickets.pdf`);
    } catch (error: any) {
      console.error('Download tickets bundle error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to generate tickets PDF');
    }
  }

  /**
   * Shareable ticket-PDF endpoint, used by the service-auth surfaces:
   *  - user-app  : proxied with a Keshless user JWT → service auth attaches
   *                req.ticketsUser.userPhone (must match the ticket's phone)
   *  - dashboard : vendor JWT → req.ticketsUser.vendorId (must own the ticket,
   *                or be a super-admin)
   *
   * Response envelope (data):
   *   { status: 'ready',      pdfUrl }  (200) — share/download this URL
   *   { status: 'generating' }          (202) — poll again shortly
   */
  static async getTicketPdf(req: Request, res: Response): Promise<any> {
    try {
      const idOrCode = req.params['ticketId'];
      if (!idOrCode) {
        return ApiResponseUtil.badRequest(res, 'Ticket id is required');
      }

      const ticket = await TicketPdfService.resolveTicket(idOrCode);
      if (!ticket) {
        return ApiResponseUtil.notFound(res, 'Ticket not found');
      }

      const tu = (req as any).ticketsUser || {};
      const requesterPhone = tu.userPhone as string | undefined;
      const vendorId = tu.vendorId as string | undefined;
      const isSuperAdmin = Boolean(tu.isSuperAdmin);

      const ownsByPhone = Boolean(
        requesterPhone &&
          ticket.customerPhone &&
          normalizePhone(requesterPhone) === normalizePhone(ticket.customerPhone)
      );
      const ownsByVendor = Boolean(
        isSuperAdmin || (vendorId && ticket.vendorId?.toString() === vendorId)
      );

      if (!ownsByPhone && !ownsByVendor) {
        return ApiResponseUtil.forbidden(res, 'You are not allowed to access this ticket');
      }

      const result = await TicketPdfService.ensureTicketPdf(ticket);

      if (result.status === TicketPdfStatus.READY) {
        return ApiResponseUtil.success(res, result, 'Ticket PDF ready');
      }
      // Still rendering (a concurrent request claimed generation) — tell the
      // client to poll.
      return ApiResponseUtil.success(res, result, 'Ticket PDF is being generated', 202);
    } catch (error: any) {
      console.error('Get ticket PDF error:', error);
      return ApiResponseUtil.error(res, error.message || 'Failed to generate ticket PDF');
    }
  }
}
