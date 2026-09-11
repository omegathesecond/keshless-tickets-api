import { Router } from 'express';
import { authenticateBuyer, optionalTicketsAuth } from '@middleware/ticketsAuth.middleware';
import { requireProfilePhoto } from '@middleware/requirePhoto.middleware';
import { EventPlanController } from '@controllers/eventPlan.controller';
import { EventPlanMessageController } from '@controllers/eventPlanMessage.controller';

const router = Router();

// Fixed-segment routes MUST be registered before '/:id' so they aren't
// captured as a plan id — same convention as social.route.ts's '/users/search'.
router.get('/mine', authenticateBuyer, EventPlanController.mine);
router.get('/event/:eventId', optionalTicketsAuth, EventPlanController.listForEvent);
router.post('/', authenticateBuyer, requireProfilePhoto, EventPlanController.create);

router.post('/invites/:memberId/accept', authenticateBuyer, EventPlanController.acceptInvite);
router.post('/invites/:memberId/decline', authenticateBuyer, EventPlanController.declineInvite);
router.post('/requests/:memberId/approve', authenticateBuyer, EventPlanController.approveRequest);
router.post('/requests/:memberId/decline', authenticateBuyer, EventPlanController.declineRequest);

router.get('/:id', optionalTicketsAuth, EventPlanController.detail);
router.get('/:id/pending', authenticateBuyer, EventPlanController.pending);
router.patch('/:id', authenticateBuyer, EventPlanController.update);
router.patch('/:id/visibility', authenticateBuyer, EventPlanController.changeVisibility);
router.post('/:id/cancel', authenticateBuyer, EventPlanController.cancel);
router.post('/:id/join', authenticateBuyer, requireProfilePhoto, EventPlanController.join);
router.post('/:id/leave', authenticateBuyer, EventPlanController.leave);
router.post('/:id/invite', authenticateBuyer, requireProfilePhoto, EventPlanController.invite);
router.post('/:id/invite/:memberId/cancel', authenticateBuyer, EventPlanController.cancelInvite);
router.post('/:id/members/:memberId/remove', authenticateBuyer, EventPlanController.removeMember);
router.post('/:id/attendance', authenticateBuyer, EventPlanController.vote);

router.get('/:id/messages', optionalTicketsAuth, EventPlanMessageController.list);
router.post('/:id/messages', authenticateBuyer, requireProfilePhoto, EventPlanMessageController.send);
router.post('/:id/messages/:messageId/react', authenticateBuyer, EventPlanMessageController.react);
router.delete('/:id/messages/:messageId/react', authenticateBuyer, EventPlanMessageController.unreact);

export default router;
