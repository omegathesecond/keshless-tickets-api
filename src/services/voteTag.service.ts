import { AttendeeTag, IAttendeeTag } from '@models/attendeeTag.model';
import { VoteQuestion } from '@models/voteQuestion.model';
import { Buyer, IBuyer } from '@models/buyer.model';
import { BlockService } from '@services/block.service';
import { NotificationDispatcher } from '@services/notificationDispatcher.service';
import { HttpError } from '@utils/httpError.util';
import { HEX24 } from '@utils/controllerHelpers.util';

const displayName = (b: IBuyer): string => b.username ?? b.name ?? 'Someone';

/**
 * "Who are you attending with?" attendee tagging (spec §2). Mirrors
 * MeetupService's request/accept/decline shape, with two differences:
 * scoped to one Vote question (not global), and a declined tag is removed by
 * the tagger rather than re-requestable in place (see attendeeTag.model's
 * doc comment).
 */
export class VoteTagService {
  static async request(tagger: IBuyer, questionId: string, targetUserId: string): Promise<IAttendeeTag> {
    const taggerId = String(tagger._id);
    if (!HEX24.test(questionId)) throw new HttpError(400, 'Invalid question id');
    if (!HEX24.test(targetUserId)) throw new HttpError(400, 'Invalid user id');
    if (taggerId === targetUserId) throw new HttpError(400, 'You cannot tag yourself');

    const question = await VoteQuestion.findOne({ _id: questionId, kind: 'attending_with' }).select('eventId');
    if (!question) throw new HttpError(404, 'Question not found');

    const target = await Buyer.findById(targetUserId).select('username');
    if (!target) throw new HttpError(404, 'User not found');

    if (await BlockService.isBlockedEitherWay(taggerId, targetUserId)) {
      throw new HttpError(403, 'You cannot tag this user');
    }

    try {
      const tag = await AttendeeTag.create({
        eventId: question.eventId,
        questionId,
        taggedById: taggerId,
        taggedUserId: targetUserId,
      });
      NotificationDispatcher.dispatchAsync(
        [targetUserId],
        'vote_tag_request',
        displayName(tagger),
        'said you\'re going together — confirm?',
        { buyerId: taggerId, username: tagger.username ?? null, tagId: String(tag._id), questionId, eventId: String(question.eventId) },
        taggerId
      );
      return tag;
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      throw new HttpError(409, 'You have already tagged this person here');
    }
  }

  private static async loadForTarget(tagId: string, buyerId: string): Promise<IAttendeeTag> {
    if (!HEX24.test(tagId)) throw new HttpError(400, 'Invalid tag id');
    const tag = await AttendeeTag.findById(tagId);
    if (!tag) throw new HttpError(404, 'Tag not found');
    if (String(tag.taggedUserId) !== buyerId) throw new HttpError(403, 'Not your tag to respond to');
    return tag;
  }

  static async confirm(target: IBuyer, tagId: string): Promise<void> {
    const tag = await VoteTagService.loadForTarget(tagId, String(target._id));
    if (tag.status === 'confirmed') return; // idempotent
    if (tag.status !== 'pending') throw new HttpError(409, 'This tag is no longer pending');
    const updated = await AttendeeTag.findOneAndUpdate(
      { _id: tag._id, status: 'pending' },
      { $set: { status: 'confirmed', respondedAt: new Date() } },
      { new: true }
    );
    if (!updated) return;
    NotificationDispatcher.dispatchAsync(
      [String(updated.taggedById)],
      'vote_tag_response',
      displayName(target),
      'confirmed they\'re going with you',
      { buyerId: String(target._id), username: target.username ?? null, tagId, questionId: String(updated.questionId), eventId: String(updated.eventId), status: 'confirmed' },
      String(target._id)
    );
  }

  static async decline(target: IBuyer, tagId: string): Promise<void> {
    const tag = await VoteTagService.loadForTarget(tagId, String(target._id));
    if (tag.status === 'declined') return; // idempotent
    if (tag.status !== 'pending') throw new HttpError(409, 'This tag is no longer pending');
    const updated = await AttendeeTag.findOneAndUpdate(
      { _id: tag._id, status: 'pending' },
      { $set: { status: 'declined', respondedAt: new Date() } },
      { new: true }
    );
    if (!updated) return;
    NotificationDispatcher.dispatchAsync(
      [String(updated.taggedById)],
      'vote_tag_response',
      displayName(target),
      'declined the attending-with tag',
      { buyerId: String(target._id), username: target.username ?? null, tagId, questionId: String(updated.questionId), eventId: String(updated.eventId), status: 'declined' },
      String(target._id)
    );
  }

  /** "Users must be able to remove a tag they created" (spec §2) — only the
   *  tagger, in any status (pending, confirmed, or declined). */
  static async remove(tagger: IBuyer, tagId: string): Promise<void> {
    if (!HEX24.test(tagId)) throw new HttpError(400, 'Invalid tag id');
    const tag = await AttendeeTag.findById(tagId);
    if (!tag) return; // already gone — idempotent
    if (String(tag.taggedById) !== String(tagger._id)) throw new HttpError(403, 'Not your tag to remove');
    await tag.deleteOne();
  }
}
