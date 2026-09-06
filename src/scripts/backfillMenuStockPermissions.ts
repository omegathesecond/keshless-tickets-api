/**
 * One-time, idempotent backfill of `TicketsPermission.MANAGE_STOCK` and
 * `MANAGE_MENU` onto persisted `TicketsUserAccess.permissions` arrays for the
 * sub-user role(s) that legitimately hold them per `TICKETS_ROLE_PERMISSIONS`.
 *
 * WHY this is needed: MANAGE_STOCK (cashless catalogue/stock) and MANAGE_MENU
 * (the organizer's event Menu tab — bar/vendor preorder catalogue) were both
 * added to the permission enum after `TicketsUserAccess` rows already
 * existed for MANAGER sub-users. `TICKETS_ROLE_PERMISSIONS[MANAGER]` grants
 * both going forward, but existing rows were persisted BEFORE either enum
 * value existed, so their stored `permissions` array contains neither.
 * `TicketsAuthService.getMe` (sub-user branch) reads that persisted array,
 * NOT the role table, so without this backfill an affected MANAGER silently
 * never gets the Menu (or Catalogue) tab — fails closed, no error: the tab
 * just never appears, even after logging out and back in. Same class of bug
 * as `backfillEditBrandPermission.ts`, which this mirrors.
 *
 * Scope is derived from `TICKETS_ROLE_PERMISSIONS` (not hardcoded) so this
 * stays correct if role grants change, with the same deliberate exclusion as
 * the EDIT_BRAND backfill:
 *   - OWNER also carries both permissions in the table, but OWNER
 *     permissions are re-derived live from the vendor record on every
 *     refresh/login/getMe (see `TicketsAuthService.getMe`/`refreshAccessToken`)
 *     and are never persisted to TicketsUserAccess — nothing to backfill.
 *   - SALES/SCANNER never appear in the derived set because
 *     TICKETS_ROLE_PERMISSIONS does not grant them either permission.
 *
 * The query excludes rows that already carry both permissions (mirrors the
 * `{ field: { $exists: false } }` filter idiom in the other backfill
 * scripts) so re-runs are a true no-op rather than just harmlessly bumping
 * `updatedAt` (TicketsUserAccess has `timestamps: true`).
 *
 * Safe to run against the OLD code too, the same as the existing backfill
 * scripts in this directory.
 */
import mongoose from 'mongoose';
import { TicketsUserAccess } from '@models/ticketsUserAccess.model';
import {
  TicketsRole,
  TicketsPermission,
  TICKETS_ROLE_PERMISSIONS,
} from '@interfaces/ticketsPermission.interface';

const PERMISSIONS_TO_BACKFILL = [
  TicketsPermission.MANAGE_STOCK,
  TicketsPermission.MANAGE_MENU,
] as const;

const rolesToBackfill = (Object.keys(TICKETS_ROLE_PERMISSIONS) as TicketsRole[]).filter(
  (role) =>
    role !== TicketsRole.OWNER &&
    PERMISSIONS_TO_BACKFILL.every((p) => TICKETS_ROLE_PERMISSIONS[role].includes(p)),
);

export async function backfillMenuStockPermissions(): Promise<{ updated: number }> {
  const res = await TicketsUserAccess.updateMany(
    {
      role: { $in: rolesToBackfill },
      permissions: { $not: { $all: PERMISSIONS_TO_BACKFILL as unknown as TicketsPermission[] } },
    },
    { $addToSet: { permissions: { $each: PERMISSIONS_TO_BACKFILL } } },
  );
  return { updated: res.modifiedCount };
}

// Allow running directly: `ts-node -r tsconfig-paths/register src/scripts/backfillMenuStockPermissions.ts`
if (require.main === module) {
  (async () => {
    const uri = process.env['MONGODB_URI'];
    if (!uri) throw new Error('MONGODB_URI is not set');
    await mongoose.connect(uri);
    const counts = await backfillMenuStockPermissions();
    console.log('[backfillMenuStockPermissions] done:', counts);
    await mongoose.disconnect();
  })().catch((err) => {
    console.error('[backfillMenuStockPermissions] failed:', err);
    process.exit(1);
  });
}
