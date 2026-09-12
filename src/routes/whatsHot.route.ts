import { Router } from 'express';
import { WhatsHotController } from '@controllers/whatsHot.controller';

const router = Router();

router.get('/', WhatsHotController.seeAll);

export default router;
