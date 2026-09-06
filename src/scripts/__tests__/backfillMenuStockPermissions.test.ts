import mongoose from 'mongoose';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../../__tests__/helpers/mongo';
import { TicketsUserAccess } from '@models/ticketsUserAccess.model';
import { TicketsRole, TicketsPermission } from '@interfaces/ticketsPermission.interface';
import { backfillMenuStockPermissions } from '../backfillMenuStockPermissions';

beforeAll(connectTestDb);
afterEach(clearTestDb);
afterAll(disconnectTestDb);

async function legacyAccess(role: TicketsRole, permissions: TicketsPermission[]) {
  return TicketsUserAccess.create({
    userId: new mongoose.Types.ObjectId(),
    vendorId: new mongoose.Types.ObjectId(),
    role,
    permissions,
    isActive: true,
  });
}

describe('backfillMenuStockPermissions', () => {
  it('grants MANAGE_STOCK and MANAGE_MENU to a MANAGER access row missing both', async () => {
    const manager = await legacyAccess(TicketsRole.MANAGER, [
      TicketsPermission.CREATE_EVENT,
      TicketsPermission.EDIT_EVENT,
    ]);

    expect(manager.permissions).not.toContain(TicketsPermission.MANAGE_STOCK);
    expect(manager.permissions).not.toContain(TicketsPermission.MANAGE_MENU);

    const result = await backfillMenuStockPermissions();
    expect(result.updated).toBe(1);

    const refreshed = await TicketsUserAccess.findById(manager._id).lean();
    expect(refreshed?.permissions).toContain(TicketsPermission.MANAGE_STOCK);
    expect(refreshed?.permissions).toContain(TicketsPermission.MANAGE_MENU);
  });

  it('grants only the missing one when a MANAGER row already has MANAGE_STOCK', async () => {
    const manager = await legacyAccess(TicketsRole.MANAGER, [
      TicketsPermission.CREATE_EVENT,
      TicketsPermission.MANAGE_STOCK,
    ]);

    const result = await backfillMenuStockPermissions();
    expect(result.updated).toBe(1);

    const refreshed = await TicketsUserAccess.findById(manager._id).lean();
    expect(refreshed?.permissions).toContain(TicketsPermission.MANAGE_STOCK);
    expect(refreshed?.permissions).toContain(TicketsPermission.MANAGE_MENU);
  });

  it('does NOT grant either permission to a SALES access row', async () => {
    const sales = await legacyAccess(TicketsRole.SALES, [
      TicketsPermission.VIEW_EVENTS,
      TicketsPermission.SELL_TICKETS,
    ]);

    const result = await backfillMenuStockPermissions();
    expect(result.updated).toBe(0);

    const refreshed = await TicketsUserAccess.findById(sales._id).lean();
    expect(refreshed?.permissions).not.toContain(TicketsPermission.MANAGE_STOCK);
    expect(refreshed?.permissions).not.toContain(TicketsPermission.MANAGE_MENU);
  });

  it('does NOT grant either permission to a SCANNER access row', async () => {
    const scanner = await legacyAccess(TicketsRole.SCANNER, [
      TicketsPermission.VIEW_EVENTS,
      TicketsPermission.SCAN_TICKETS,
    ]);

    const result = await backfillMenuStockPermissions();
    expect(result.updated).toBe(0);

    const refreshed = await TicketsUserAccess.findById(scanner._id).lean();
    expect(refreshed?.permissions).not.toContain(TicketsPermission.MANAGE_STOCK);
    expect(refreshed?.permissions).not.toContain(TicketsPermission.MANAGE_MENU);
  });

  it('is idempotent: a second run touches nothing', async () => {
    await legacyAccess(TicketsRole.MANAGER, [TicketsPermission.CREATE_EVENT]);
    await legacyAccess(TicketsRole.SALES, [TicketsPermission.SELL_TICKETS]);

    const first = await backfillMenuStockPermissions();
    expect(first.updated).toBe(1);

    const second = await backfillMenuStockPermissions();
    expect(second.updated).toBe(0);
  });

  it('is a no-op for a MANAGER row that already has both permissions', async () => {
    await legacyAccess(TicketsRole.MANAGER, [
      TicketsPermission.CREATE_EVENT,
      TicketsPermission.MANAGE_STOCK,
      TicketsPermission.MANAGE_MENU,
    ]);

    const result = await backfillMenuStockPermissions();
    expect(result.updated).toBe(0);
  });
});
