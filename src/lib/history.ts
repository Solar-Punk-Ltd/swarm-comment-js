import { FeedIndex, Topic } from '@ethersphere/bee-js';
import {
  getReactionFeedId,
  isNotFoundError,
  MessageData,
  readCommentsInRange,
  readReactionsWithIndex,
  readSingleComment,
} from '@solarpunkltd/comment-system';

import { CommentSettingsSwarm } from '../interfaces';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';
import { validateUserSignature } from '../utils/validation';

import { COMMENTS_TO_READ, EVENTS, FEED_INDEX_ZERO } from './constants';

export class SwarmHistory {
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();
  private startIndex = -1n;

  constructor(
    private swarmSettings: CommentSettingsSwarm,
    private emitter: EventEmitter,
  ) {}

  public async init(startIx?: bigint): Promise<void> {
    try {
      if (startIx !== undefined) {
        this.startIndex = startIx;
        this.logger.debug(`Skipping history fetching, start index: ${this.startIndex.toString()}`);
        return;
      }

      const { data, index } = await this.fetchLatestMessage();

      if (index.toBigInt() > -1n) {
        this.emitter.emit(EVENTS.MESSAGE_RECEIVED, data);
      }

      this.startIndex = index.toBigInt();

    } catch (error) {
      if (isNotFoundError(error)) {
        this.logger.debug('No latest comment found for message state initialization');
        return;
      }

      this.errorHandler.handleError(error, 'SwarmHistory.init');
      return;
    }
  }

  public async fetchPreviousMessageState(): Promise<void> {
    if (this.startIndex <= 0n) {
      return;
    }

    const newStartIndex = this.startIndex > COMMENTS_TO_READ ? this.startIndex - COMMENTS_TO_READ : 0n;

    this.logger.debug(
      'Fetching previous messages from: ',
      newStartIndex.toString(),
      ' to: ',
      this.startIndex.toString(),
    );

    const comments = await readCommentsInRange(
      FeedIndex.fromBigInt(newStartIndex),
      FeedIndex.fromBigInt(this.startIndex),
      {
        identifier: Topic.fromString(this.swarmSettings.topic).toString(),
        address: this.swarmSettings.address,
        beeApiUrl: this.swarmSettings.beeUrl,
      },
    );

    if (!comments) {
      return;
    }

    for (let ix = 0; ix < comments.length; ix++) {
      const c = comments[ix];

      if (!validateUserSignature(c)) {
        this.logger.warn('Invalid signature detected:', c);
        continue;
      }

      this.emitter.emit(EVENTS.MESSAGE_RECEIVED, c);
    }

    this.startIndex = newStartIndex;
  }

  public async fetchLatestReactionState(index?: bigint, prevIndex?: bigint): Promise<FeedIndex> {
    const reactionFeedId = getReactionFeedId(Topic.fromString(this.swarmSettings.topic).toString()).toString();
    const reactionState = await readReactionsWithIndex(index === undefined ? undefined : FeedIndex.fromBigInt(index), {
      identifier: reactionFeedId,
      address: this.swarmSettings.address,
      beeApiUrl: this.swarmSettings.beeUrl,
    });

    if (!reactionState || !reactionState.messages || reactionState.messages.length === 0) {
      return FEED_INDEX_ZERO;
    }

    if (prevIndex !== undefined && new FeedIndex(reactionState.nextIndex).toBigInt() > prevIndex) {
      for (let ix = 0; ix < reactionState.messages.length; ix++) {
        const r = reactionState.messages[ix];

        this.emitter.emit(EVENTS.MESSAGE_RECEIVED, r);
      }
    }

    return new FeedIndex(reactionState.nextIndex);
  }

  public async fetchLatestMessage(): Promise<{ data: MessageData; index: FeedIndex }> {
    const latestComment = await readSingleComment(undefined, {
      identifier: Topic.fromString(this.swarmSettings.topic).toString(),
      address: this.swarmSettings.address,
      beeApiUrl: this.swarmSettings.beeUrl,
    });

    if (!latestComment || Object.keys(latestComment).length === 0) {
      this.logger.debug(`No comment found in history`);
      return { data: {} as MessageData, index: FeedIndex.MINUS_ONE };
    }

    if (!validateUserSignature(latestComment.message)) {
      this.logger.warn('Invalid signature during fetching');
      return { data: {} as MessageData, index: FeedIndex.MINUS_ONE };
    }

    return { data: latestComment.message, index: new FeedIndex(latestComment.message.index) };
  }

  public hasPreviousMessages(): boolean {
    return this.startIndex > 0n;
  }

  public cleanup(): void {
    this.startIndex = -1n;
  }
}
