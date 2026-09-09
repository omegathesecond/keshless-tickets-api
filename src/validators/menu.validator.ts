import Joi from 'joi';
import { MenuSection } from '@models/menuItem.model';
import { PaymentMethod } from '@interfaces/ticket.interface';

const MAX_PRICE_CENTS = 100_000_00; // R100,000/item ceiling, defense-in-depth
const MAX_ITEMS_PER_ORDER = 30;
export const MAX_QTY_PER_LINE = 50;

export interface MenuOrderLine {
  menuItemId: string;
  quantity: number;
}

/**
 * Collapse repeated lines of one item into a single line with the summed
 * quantity (first-seen order kept). Runs BEFORE the per-line cap — both here
 * and in MenuOrderService.buildLineItems — so a quantity split across lines
 * cannot slip past it.
 */
export function mergeMenuOrderLines(lines: MenuOrderLine[]): MenuOrderLine[] {
  const merged = new Map<string, number>();
  for (const line of lines) {
    const key = String(line.menuItemId);
    merged.set(key, (merged.get(key) ?? 0) + line.quantity);
  }
  return [...merged].map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
}

function mergeAndCapLines(value: MenuOrderLine[], helpers: Joi.CustomHelpers): MenuOrderLine[] | Joi.ErrorReport {
  const merged = mergeMenuOrderLines(value);
  const over = merged.find(l => l.quantity > MAX_QTY_PER_LINE);
  if (over) {
    return helpers.message({
      custom: `Quantity for a single item cannot exceed ${MAX_QTY_PER_LINE} (item ${over.menuItemId} totals ${over.quantity} across lines)`,
    });
  }
  return merged;
}

export const createMenuItemSchema = Joi.object({
  section: Joi.string().valid(...Object.values(MenuSection)).required(),
  vendorName: Joi.string().trim().max(120).optional(),
  category: Joi.string().trim().min(1).max(80).required(),
  name: Joi.string().trim().min(1).max(120).required(),
  description: Joi.string().trim().max(500).allow('').optional(),
  price: Joi.number().integer().min(0).max(MAX_PRICE_CENTS).required(),
  imageUrl: Joi.string().trim().uri().optional(),
  displayOrder: Joi.number().integer().min(0).optional(),
});

export const updateMenuItemSchema = Joi.object({
  section: Joi.string().valid(...Object.values(MenuSection)),
  vendorName: Joi.string().trim().max(120).allow(null, ''),
  category: Joi.string().trim().min(1).max(80),
  name: Joi.string().trim().min(1).max(120),
  description: Joi.string().trim().max(500).allow(null, ''),
  price: Joi.number().integer().min(0).max(MAX_PRICE_CENTS),
  imageUrl: Joi.string().trim().uri().allow(null, ''),
  active: Joi.boolean(),
  displayOrder: Joi.number().integer().min(0),
}).min(1);

export const createMenuOrderSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        menuItemId: Joi.string().trim().required(),
        quantity: Joi.number().integer().min(1).max(MAX_QTY_PER_LINE).required(),
      }),
    )
    .min(1)
    .max(MAX_ITEMS_PER_ORDER)
    .required()
    .custom(mergeAndCapLines, 'merge duplicate lines, then cap'),
  paymentMethod: Joi.string().valid(PaymentMethod.KESHLESS_WALLET, PaymentMethod.MTN_MOMO).required(),
  keshlessCardNumber: Joi.string().trim().when('paymentMethod', {
    is: PaymentMethod.KESHLESS_WALLET,
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  keshlessPin: Joi.string().trim().optional(),
  momoPhone: Joi.string().trim().when('paymentMethod', {
    is: PaymentMethod.MTN_MOMO,
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  buyerName: Joi.string().trim().max(120).optional(),
  notes: Joi.string().trim().max(500).allow('').optional(),
});

export const updateMenuOrderFulfillmentSchema = Joi.object({
  fulfillmentStatus: Joi.string().valid('new', 'preparing', 'ready', 'collected', 'cancelled').required(),
});

/** The value encoded in the buyer's order QR is just order.orderId — no
 *  payment or personal details, so a leaked/photographed code identifies an
 *  order but exposes nothing sensitive. */
export const scanMenuOrderSchema = Joi.object({
  orderId: Joi.string().trim().min(1).required(),
});
