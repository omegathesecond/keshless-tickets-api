import { Request, Response } from 'express';
import { ApiResponseUtil } from '@utils/apiResponse.util';
import { failWithHttpError } from '@utils/controllerHelpers.util';
import { resolveActorFromRequest } from '@utils/socialActor.util';
import { listQuestions, listRecent, listRecentGeneral, getQuestion, createQuestion, createReply, toggleQuestionLike } from '@services/eventQuestion.service';

/**
 * Event Q&A — questions/replies/likes scoped to an event, for the
 * TopicsPage discussion threads. Mounted with optionalTicketsAuth (accepts a
 * buyer OR vendor token, or anonymous); reads degrade gracefully to an
 * anonymous view, writes 401 when no actor resolves.
 */
export class EventQuestionController {
  /** GET /api/community/:eventId/questions */
  static async list(req: Request, res: Response): Promise<any> {
    try {
      const eventId = req.params['eventId'] as string;
      // A failed lookup here just means an unpersonalized (viewerHasLiked:false)
      // view, same call as update.controller's listByEvent/listByAuthor — a DB
      // blip resolving the actor shouldn't turn a read into a 500.
      const actor = await resolveActorFromRequest(req).catch(() => null);
      return ApiResponseUtil.success(res, await listQuestions(eventId, actor));
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load questions');
    }
  }

  /**
   * GET /api/public/questions
   * The most recent Q&A questions ACROSS ALL events, newest first — powers
   * the TopicsPage cross-event discussion list (the per-event thread is the
   * `list` method above). Public + optionalTicketsAuth: an anonymous caller
   * just gets viewerHasLiked:false on every row, same graceful degrade as
   * `list`.
   */
  static async listRecent(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req).catch(() => null);
      // Same defensive clamp as PublicController.getActivity: a malformed or
      // out-of-range query param must fall back to the default, never reach
      // the DB query as NaN (which Mongo treats as "no limit" — unbounded).
      const requested = parseInt(String(req.query['limit'] ?? '20'), 10);
      const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 20, 1), 50);
      const questions = await listRecent(actor, limit);
      return ApiResponseUtil.success(res, { questions });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load recent questions');
    }
  }

  /**
   * GET /api/public/questions/general
   * The most recent GENERAL posts only (no event) — powers "Chat with
   * Everyone", which never shows event-specific discussion. Sibling of
   * listRecent (cross-event, for TopicsPage).
   */
  static async listRecentGeneral(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req).catch(() => null);
      const requested = parseInt(String(req.query['limit'] ?? '20'), 10);
      const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 20, 1), 50);
      const questions = await listRecentGeneral(actor, limit);
      return ApiResponseUtil.success(res, { questions });
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load recent questions');
    }
  }

  /**
   * GET /api/community/questions/:questionId
   * One topic (question) hydrated with its replies + event, for the standalone
   * conversation page. Public + optionalTicketsAuth: anonymous callers can read
   * the thread (viewerHasLiked:false); a missing id 404s.
   */
  static async get(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req).catch(() => null);
      const question = await getQuestion(req.params['questionId'] as string, actor);
      if (!question) return ApiResponseUtil.notFound(res, 'Group chat not found');
      return ApiResponseUtil.success(res, question);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to load group chat');
    }
  }

  /** POST /api/community/:eventId/questions */
  static async create(req: Request, res: Response): Promise<any> {
    try {
      // NOT `.catch(() => null)`: this is a write, so a real error resolving
      // the actor (a DB blip, not "no token") must surface as a 500, not a
      // misleading "please sign in" to someone who is in fact signed in. See
      // the identical reasoning in eventReaction.controller's like().
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const eventId = req.params['eventId'] as string;
      const question = await createQuestion(eventId, actor, req.body?.body);
      return ApiResponseUtil.created(res, question);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to post question');
    }
  }

  /**
   * POST /api/community/questions — a general post on "Chat with Everyone",
   * not scoped to any event (see createQuestion's null-eventId branch).
   */
  static async createGeneral(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const question = await createQuestion(null, actor, req.body?.body);
      return ApiResponseUtil.created(res, question);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to post');
    }
  }

  /** POST /api/community/questions/:questionId/replies */
  static async reply(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const questionId = req.params['questionId'] as string;
      const reply = await createReply(questionId, actor, req.body?.body);
      return ApiResponseUtil.created(res, reply);
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to post reply');
    }
  }

  /** POST /api/community/questions/:questionId/like */
  static async like(req: Request, res: Response): Promise<any> {
    try {
      const actor = await resolveActorFromRequest(req);
      if (!actor) return ApiResponseUtil.unauthorized(res, 'Please sign in first');
      const questionId = req.params['questionId'] as string;
      return ApiResponseUtil.success(res, await toggleQuestionLike(questionId, actor));
    } catch (error: any) {
      return failWithHttpError(res, error, 'Failed to like question');
    }
  }
}
