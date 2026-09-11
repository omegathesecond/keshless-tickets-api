import { Router } from 'express';
import { authenticateBuyer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { WeekendController } from '@controllers/weekend.controller';

const router = Router();

// Fixed-segment routes before '/users/:username' — same convention as
// social.route.ts's '/users/search'.
router.get('/me', authenticateBuyer, WeekendController.getMine);
router.put('/me', authenticateBuyer, requireProfilePhoto, WeekendController.upsertMine);
router.delete('/me', authenticateBuyer, WeekendController.removeMine);

router.get('/feed', optionalTicketsAuth, WeekendController.feed);
router.get('/feed/looking-for-plans', optionalTicketsAuth, WeekendController.lookingForPlansFeed);

router.post('/requests', authenticateBuyer, requireProfilePhoto, WeekendController.createRequest);
router.get('/requests', authenticateBuyer, WeekendController.listRequests);
router.post('/requests/:id/accept', authenticateBuyer, WeekendController.acceptRequest);
router.post('/requests/:id/decline', authenticateBuyer, WeekendController.declineRequest);
router.delete('/requests/:id', authenticateBuyer, WeekendController.cancelRequest);

router.get('/users/:username', optionalTicketsAuth, WeekendController.getForUser);

export default router;
