// api/src/interfaces/operatorGrant.interface.ts
import { TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { CashierPermission } from '@interfaces/cashier.interface';
import { MerchantPermission } from '@interfaces/merchant.interface';
import { WaiterPermission, WAITER_PERMISSIONS } from '@interfaces/waiter.interface';

/**
 * Capabilities an organizer can grant to an INDIVIDUAL operator, on top of
 * whatever their role already carries. Roles stay the floor (a gate operator
 * always scans, a cashier always tops up); grants are the per-person extras,
 * which is what makes this RBAC rather than four fixed job descriptions.
 *
 * Stored namespace-free on the operator row, and each auth service translates
 * a grant into its own namespace when minting the token. Not every grant
 * means something in every namespace — one capability is declared once and
 * mapped per namespace, and a grant with no mapping in a namespace yields
 * nothing there.
 */
export enum OperatorGrant {
  /**
   * The REGISTER desk. Two jobs, one capability because they are the same
   * person at the same table: enrol the organizer's physical tags into an
   * event's register (see EventTag), and bind one of those tags to an
   * attendee's ticket. Whoever holds this grant logs into the POS as
   * `type: 'register'` rather than `type: 'gate'`.
   */
  ISSUE_TAGS = 'issue_tags',
  /**
   * The stall's STOCK CONTROLLER. Receives deliveries into this stall, writes
   * off breakage, and moves stock to another stall — all scoped to the stall
   * the operator belongs to. Held by a MerchantOperator; it means nothing on a
   * gate operator or cashier, whose namespaces deliberately have no mapping.
   */
  MANAGE_STOCK = 'manage_stock',
  /**
   * SETTLING a table — taking the money at the end of service. Separate from
   * serving because they are different jobs: an organizer may want the money
   * moment held by a supervisor. Held by a Waiter; it means nothing on any
   * other actor, whose namespaces have no mapping for it.
   */
  SETTLE_TABLES = 'settle_tables',
}

export const OPERATOR_GRANTS: OperatorGrant[] = Object.values(OperatorGrant);

/** Grants → the tickets namespace (gate operators). */
const TICKETS_BY_GRANT: Partial<Record<OperatorGrant, TicketsPermission>> = {
  [OperatorGrant.ISSUE_TAGS]: TicketsPermission.ISSUE_TAGS,
};

/** Grants → the cashier namespace (cashiers log in through their own middleware). */
const CASHIER_BY_GRANT: Partial<Record<OperatorGrant, CashierPermission>> = {
  [OperatorGrant.ISSUE_TAGS]: CashierPermission.ISSUE_TAGS,
};

/** Grants → the merchant namespace (stall operators on the POS). */
const MERCHANT_BY_GRANT: Partial<Record<OperatorGrant, MerchantPermission>> = {
  [OperatorGrant.MANAGE_STOCK]: MerchantPermission.MANAGE_STOCK,
};

/** Grants → the waiter namespace (floor waiters logging in through the POS). */
const WAITER_BY_GRANT: Partial<Record<OperatorGrant, WaiterPermission>> = {
  [OperatorGrant.SETTLE_TABLES]: WaiterPermission.SETTLE_TABLES,
};

/**
 * Only known grants survive. A row carrying a value that is no longer a grant
 * (renamed capability, hand-edited document) must not widen a token — the
 * filter is here rather than at write time so a stale document can't outlive
 * the validation that let it in.
 */
export function grantedTicketsPermissions(grants?: string[] | null): TicketsPermission[] {
  return (grants ?? [])
    .filter((g): g is OperatorGrant => OPERATOR_GRANTS.includes(g as OperatorGrant))
    .map((g) => TICKETS_BY_GRANT[g])
    .filter((p): p is TicketsPermission => p !== undefined);
}

export function grantedCashierPermissions(grants?: string[] | null): CashierPermission[] {
  return (grants ?? [])
    .filter((g): g is OperatorGrant => OPERATOR_GRANTS.includes(g as OperatorGrant))
    .map((g) => CASHIER_BY_GRANT[g])
    .filter((p): p is CashierPermission => p !== undefined);
}

export function grantedMerchantPermissions(grants?: string[] | null): MerchantPermission[] {
  return (grants ?? [])
    .filter((g): g is OperatorGrant => OPERATOR_GRANTS.includes(g as OperatorGrant))
    .map((g) => MERCHANT_BY_GRANT[g])
    .filter((p): p is MerchantPermission => p !== undefined);
}

/**
 * Waiters accept `unknown` rather than `string[] | null` like their siblings
 * above — the token mint reads `grants` off a Mongoose document, so routing
 * it through `sanitizeGrants` (built for the admin-write path, but an equally
 * valid filter here) is reuse rather than a third hand-rolled filter clause.
 */
export function grantedWaiterPermissions(grants: unknown): WaiterPermission[] {
  return sanitizeGrants(grants)
    .map((g) => WAITER_BY_GRANT[g])
    .filter((p): p is WaiterPermission => !!p);
}

/**
 * THE single definition of a stall operator's permission set: the role's
 * floor (merchant:charge — every person on a till can charge, no exceptions)
 * plus whatever grants the row carries, translated into the merchant
 * namespace. Both the token mint (MerchantAuthService.login, the POS's
 * rendering copy) and the per-request gate (authenticateMerchant, the
 * authoritative check) must call this rather than each spelling out the
 * formula — the two are deliberately the same computation, and duplicating
 * it is how they drift: a second baseline permission or a future `canCharge`
 * flag would have to be added in both places, and missing one lets the POS
 * render a control the API then 403s, with no test catching it because each
 * site is exercised by a different suite.
 */
export function deriveMerchantPermissions(grants?: string[] | null): MerchantPermission[] {
  return [MerchantPermission.CHARGE, ...grantedMerchantPermissions(grants)];
}

/**
 * THE single definition of a waiter's permission set — the waiter-namespace
 * twin of [deriveMerchantPermissions], and it exists for the same reason.
 *
 * The role floor (view events, manage tables) plus whatever the row's grants
 * add — today only settling. Both the token mint (WaiterAuthService.login,
 * the POS's rendering copy) and the per-request gate (authenticateWaiter, the
 * authoritative check) call this rather than each spelling out the formula,
 * because the two are deliberately the same computation and duplicating it is
 * how they drift.
 */
export function deriveWaiterPermissions(grants: unknown): WaiterPermission[] {
  return [...WAITER_PERMISSIONS, ...grantedWaiterPermissions(grants)];
}

/** Normalize an admin-supplied list: known values only, no duplicates. */
export function sanitizeGrants(input: unknown): OperatorGrant[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter((g): g is OperatorGrant => OPERATOR_GRANTS.includes(g as OperatorGrant)))];
}
