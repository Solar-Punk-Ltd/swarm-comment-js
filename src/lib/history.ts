import { FeedIndex } from '@ethersphere/bee-js';
import {
  isNotFoundError,
  MessageData,
  Options,
  readReactionsWithIndex,
  readSingleComment,
} from '@solarpunkltd/comment-system';

import { fetchMessagesInRange } from '../utils/bee';
import { indexStrToBigint } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';

import { COMMENTS_TO_READ, EVENTS, FEED_INDEX_ZERO } from './constants';

export class SwarmHistory {
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();
  private startIndex = -1n;

  constructor(
    private commentOptions: Options,
    private reactionOptions: Options,
    private emitter: EventEmitter,
  ) {}

  public async init(firstIndex?: bigint): Promise<void> {
    try {
      if (firstIndex !== undefined) {
        this.startIndex = firstIndex;
        this.logger.debug(`Skipping history fetching due to preloading, first index: ${this.startIndex}`);
        return;
      }

      const { data: comment, index } = await this.fetchLatestMessage();

      if (!index.equals(FeedIndex.MINUS_ONE)) {
        this.logger.debug(`history latest index: ${index.toBigInt()}`);
        this.emitter.emit(EVENTS.MESSAGE_RECEIVED, comment);
      }

      this.startIndex = index.toBigInt();
    } catch (error) {
      if (isNotFoundError(error)) {
        this.logger.debug('No comment found during message state initialization');
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

    await fetchMessagesInRange(newStartIndex, this.startIndex - 1n, this.emitter, this.commentOptions);

    this.startIndex = newStartIndex;
  }

  public async fetchLatestReactionState(index?: bigint, prevIndex?: bigint): Promise<FeedIndex> {
    this.logger.debug(
      'Fetching reaction state at: ',
      index?.toString() || 'latest',
      ' previous index: ',
      prevIndex?.toString(),
    );

    const reactionState = await readReactionsWithIndex(
      index === undefined ? undefined : FeedIndex.fromBigInt(index),
      this.reactionOptions,
    );

    const nextIxBigInt = indexStrToBigint(reactionState.nextIndex);
    if (!nextIxBigInt || nextIxBigInt < 0n || FeedIndex.fromBigInt(nextIxBigInt).equals(FeedIndex.MINUS_ONE)) {
      return FEED_INDEX_ZERO;
    }

    if (prevIndex !== undefined && nextIxBigInt > prevIndex + 1n) {
      for (let ix = 0; ix < reactionState.messages.length; ix++) {
        const reaction = reactionState.messages[ix];
        this.emitter.emit(EVENTS.MESSAGE_RECEIVED, reaction);
      }
    }

    return FeedIndex.fromBigInt(nextIxBigInt);
  }

  public async fetchLatestMessage(): Promise<{ data: MessageData; index: FeedIndex }> {
    const latestComment = await readSingleComment(undefined, this.commentOptions);

    const parsedIx = indexStrToBigint(latestComment?.index);
    if (!latestComment || !parsedIx) {
      this.logger.debug(`No comment found in history`);
      return { data: {} as MessageData, index: FeedIndex.MINUS_ONE };
    }

    return { data: latestComment, index: FeedIndex.fromBigInt(parsedIx) };
  }

  public hasPreviousMessages(): boolean {
    return this.startIndex > 0n;
  }

  public cleanup(): void {
    this.startIndex = -1n;
  }
}
