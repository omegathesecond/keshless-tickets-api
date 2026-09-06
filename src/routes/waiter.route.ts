import { Router } from 'express';
import { WaiterController } from '@controllers/waiter.controller';
import { authenticateWaiter, requireWaiterPermission } from '@middleware/waiterAuth.middleware';
import { WaiterPermission } from '@interfaces/waiter.interface';

const router = Router();
router.use(authenticateWaiter);

router.get('/events', requireWaiterPermission(WaiterPermission.VIEW_EVENTS), WaiterController.getEvents);

// VIEW_EVENTS, not MANAGE_TABLES: the event-wide product grid is a read of the
// catalogue, the same class of thing as /events. Nothing on a table moves.
router.get('/products', requireWaiterPermission(WaiterPermission.VIEW_EVENTS), WaiterController.getProducts);

router.post('/tables', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.openTable);
router.get('/tables', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.listTables);
router.post('/tables/:id/items', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.addItem);
router.delete('/tables/:id/items/:lineId', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.removeItem);
router.post('/tables/:id/void', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.voidTable);
// Taking delivery of a round is the SERVING job, so it rides on MANAGE_TABLES
// — a waiter barred from the money still has to be able to collect the drinks.
router.post('/tables/:id/stalls/:merchantId/accept', requireWaiterPermission(WaiterPermission.MANAGE_TABLES), WaiterController.acceptStall);
// SETTLE_TABLES, deliberately NOT MANAGE_TABLES: serving a table and taking
// money for it are different jobs, and the money one is a separate per-person
// grant (see WAITER_PERMISSIONS, which omits it).
router.post('/tables/:id/settle', requireWaiterPermission(WaiterPermission.SETTLE_TABLES), WaiterController.settleTable);

export default router;
