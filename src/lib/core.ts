import { EthAddress, FeedIndex, PrivateKey, Topic, UploadResult } from '@ethersphere/bee-js';
import {
  getPrivateKeyFromIdentifier,
  getReactionFeedId,
  MessageData,
  MessageType,
  Options,
  readSingleComment,
  updateReactions,
  writeCommentToIndex,
  writeReactionsToIndex,
} from '@solarpunkltd/comment-system';
import { v4 as uuidv4 } from 'uuid';

import { CommentSettings, CommentSettingsUser, PreloadOptions } from '../interfaces';
import { fetchMessagesInRange } from '../utils/bee';
import { indexStrToBigint, remove0x, retryAwaitableAsync } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';
import { Logger } from '../utils/logger';

import {
  COMMENTS_TO_READ,
  DEFAULT_POLL_INTERVAL,
  EVENTS,
  FEED_INDEX_ZERO,
  MINIMUM_POLL_INTERVAL,
  PLACEHOLDER_STAMP,
} from './constants';
import { SwarmHistory } from './history';

export class SwarmComment {
  private logger = Logger.getInstance();
  private errorHandler = ErrorHandler.getInstance();

  private emitter: EventEmitter;
  private history: SwarmHistory;
  private userDetails: CommentSettingsUser;
  private commentOptions: Options;
  private reactionOptions: Options;
  private signer: PrivateKey;
  private topic: string;
  private pollInterval: number;

  private fetchProcessRunning = false;
  private stopFetch = false;
  private reactionIndex = -1n;
  private isSending = false;

  constructor(settings: CommentSettings) {
    this.emitter = new EventEmitter();

    const userSigner = new PrivateKey(remove0x(settings.user.privateKey));
    this.userDetails = {
      privateKey: settings.user.privateKey,
      ownAddress: userSigner.publicKey().address().toString(),
      nickname: settings.user.nickname,
      ownIndex: -1n,
    };

    this.pollInterval = settings.infra.pollInterval || DEFAULT_POLL_INTERVAL;
    if (this.pollInterval < MINIMUM_POLL_INTERVAL) {
      this.logger.debug('pollInterval updated to the minimum: ', MINIMUM_POLL_INTERVAL);
      this.pollInterval = MINIMUM_POLL_INTERVAL;
    }

    this.signer = getPrivateKeyFromIdentifier(settings.infra.topic);
    this.topic = Topic.fromString(settings.infra.topic).toString();

    this.commentOptions = {
      identifier: this.topic,
      address: this.signer.publicKey().address().toString(),
      beeApiUrl: settings.infra.beeUrl,
      stamp: settings.infra.stamp || PLACEHOLDER_STAMP,
      signer: this.signer,
    };

    const reactionFeedId = getReactionFeedId(this.topic).toString();
    this.reactionOptions = {
      identifier: reactionFeedId,
      address: this.signer.publicKey().address().toString(),
      beeApiUrl: settings.infra.beeUrl,
      stamp: settings.infra.stamp || PLACEHOLDER_STAMP,
      signer: this.signer,
    };

    this.history = new SwarmHistory(this.commentOptions, this.reactionOptions, this.emitter);
  }

  public start(options?: PreloadOptions): void {
    this.init(options);
    this.startMessagesFetchProcess();
  }

  public stop(): void {
    this.emitter.cleanAll();
    this.stopMessagesFetchProcess();
    this.history.cleanup();
    this.reactionIndex = -1n;
    this.fetchProcessRunning = false;
  }

  public getEmitter(): EventEmitter {
    return this.emitter;
  }

  public orderMessages(messages: any[]): any[] {
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  public async sendMessage(
    message: string,
    type: MessageType,
    targetMessageId?: string,
    id?: string,
    prevState?: MessageData[],
  ): Promise<void> {
    let messageObj = {
      id: id || uuidv4(),
      username: this.userDetails.nickname,
      address: this.userDetails.ownAddress,
      topic: this.topic,
      signature: this.getSignature(message),
      timestamp: Date.now(),
      type,
      targetMessageId,
      message,
    } as MessageData;

    try {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_INITIATED, messageObj);

      if (type === MessageType.REACTION) {
        // to avoid indexing issues, note: it slows down the sending process
        await this.fetchLatestReactions();

        const reactionNextIndex =
          this.reactionIndex === -1n ? FEED_INDEX_ZERO : FeedIndex.fromBigInt(this.reactionIndex + 1n);
        messageObj = {
          ...messageObj,
          index: reactionNextIndex.toString(),
        };

        const newReactionState = updateReactions(prevState || [], messageObj) || [];
        this.isSending = true;

        const res = await writeReactionsToIndex(newReactionState, reactionNextIndex, this.reactionOptions);

        await this.verifyWriteSuccess(reactionNextIndex, res);

        this.reactionIndex = reactionNextIndex.toBigInt();
      } else {
        // to avoid indexing issues, note: it slows down the sending process
        await this.fetchLatestMessage();

        const nextIndex = this.userDetails.ownIndex === -1n ? 0n : this.userDetails.ownIndex + 1n;
        messageObj = {
          ...messageObj,
          index: FeedIndex.fromBigInt(nextIndex).toString(),
        };

        this.isSending = true;

        const res = await writeCommentToIndex(messageObj, FeedIndex.fromBigInt(nextIndex), this.commentOptions);

        await this.verifyWriteSuccess(FeedIndex.fromBigInt(nextIndex), res, messageObj);

        this.userDetails.ownIndex = nextIndex;
      }

      this.emitter.emit(EVENTS.MESSAGE_REQUEST_UPLOADED, messageObj);
    } catch (error) {
      this.emitter.emit(EVENTS.MESSAGE_REQUEST_ERROR, messageObj);
      this.errorHandler.handleError(error, 'Comment.sendMessage');
    } finally {
      this.isSending = false;
    }
  }

  public async fetchPreviousMessages(): Promise<void> {
    try {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, true);

      await this.history.fetchPreviousMessageState();
    } finally {
      this.emitter.emit(EVENTS.LOADING_PREVIOUS_MESSAGES, false);
    }
  }

  private async init(options?: PreloadOptions): Promise<void> {
    try {
      this.emitter.emit(EVENTS.LOADING_INIT, true);

      const [ownIndexResult] = await Promise.allSettled([
        this.initOwnIndex(options?.latestIndex),
        this.history.init(options?.firstIndex ?? options?.latestIndex),
        this.initReactionIndex(options?.reactionIndex),
      ]);

      if (ownIndexResult.status === 'rejected') {
        throw ownIndexResult.reason;
      }

      this.emitter.emit(EVENTS.LOADING_INIT, false);
    } catch (error) {
      this.errorHandler.handleError(error, 'Comment.initSelfState');
      this.emitter.emit(EVENTS.CRITICAL_ERROR, error);
    }
  }

  private async initOwnIndex(latestIndex?: bigint): Promise<void> {
    if (latestIndex !== undefined) {
      this.userDetails.ownIndex = latestIndex;
      this.logger.debug(`OwnIndex set due to preloading: ${this.userDetails.ownIndex}`);
    }

    const RETRY_COUNT = 10;
    const DELAY = 1000;

    const comment = await retryAwaitableAsync(
      () => readSingleComment(undefined, this.commentOptions),
      RETRY_COUNT,
      DELAY,
    );

    const parsedIx = indexStrToBigint(comment?.index);

    if (
      parsedIx &&
      !FeedIndex.fromBigInt(parsedIx).equals(FeedIndex.MINUS_ONE) &&
      parsedIx > this.userDetails.ownIndex
    ) {
      const startIndex = latestIndex === undefined ? parsedIx - COMMENTS_TO_READ : this.userDetails.ownIndex;

      this.userDetails.ownIndex = parsedIx;
      this.logger.debug(
        `OwnIndex updated from ${startIndex} as new message(s) found since preloading: ${parsedIx}, fetching them...`,
      );

      await fetchMessagesInRange(startIndex + 1n, parsedIx, this.emitter, this.commentOptions);
    }
  }

  private async initReactionIndex(reactionIndex?: bigint): Promise<void> {
    if (reactionIndex === undefined) {
      return await this.fetchLatestReactions();
    }

    this.reactionIndex = reactionIndex;
  }

  private async fetchLatestMessage(): Promise<void> {
    if (this.isSending) return;

    try {
      const { data: comment, index } = await this.history.fetchLatestMessage();

      if (!index.equals(FeedIndex.MINUS_ONE) && this.userDetails.ownIndex < index.toBigInt()) {
        this.userDetails.ownIndex = index.toBigInt();
        this.logger.debug(`OwnIndex updated to: ${this.userDetails.ownIndex.toString()}`);

        this.emitter.emit(EVENTS.MESSAGE_RECEIVED, comment);
      }
    } catch (err) {
      this.errorHandler.handleError(err, 'Comment.fetchLatestMessage');
    }
  }

  private async fetchLatestReactions(index?: bigint): Promise<void> {
    try {
      const reactionNextIndex = (await this.history.fetchLatestReactionState(index, this.reactionIndex)).toBigInt();
      if (reactionNextIndex - 1n > this.reactionIndex) {
        this.reactionIndex = reactionNextIndex - 1n;
      }
    } catch (err) {
      this.errorHandler.handleError(err, 'Comment.fetchLatestReactions');
    }
  }

  private async verifyWriteSuccess(
    index: FeedIndex,
    writeResult: UploadResult | undefined,
    data?: MessageData,
  ): Promise<void> {
    if (!writeResult) {
      throw new Error('Write failed, empty response!');
    }

    if (!data) {
      return;
    }

    const dataCheck = await readSingleComment(index, this.commentOptions);

    if (!dataCheck) {
      throw new Error('Comment check failed, empty response!');
    }

    if (dataCheck.id !== data.id || dataCheck.timestamp !== data.timestamp) {
      throw new Error(`Write verification failed, expected "${data.message}", got: "${dataCheck.message}".
                Expected timestamp: ${data.timestamp}, got: ${dataCheck.timestamp}`);
    }
  }

  private async startMessagesFetchProcess(): Promise<void> {
    if (this.fetchProcessRunning) return;

    this.fetchProcessRunning = true;
    this.stopFetch = false;

    const poll = async (): Promise<void> => {
      if (this.stopFetch) {
        this.fetchProcessRunning = false;
        return;
      }

      await Promise.allSettled([this.fetchLatestMessage(), this.fetchLatestReactions(this.reactionIndex + 1n)]);
      setTimeout(poll, this.pollInterval);
    };

    poll();
  }

  public hasPreviousMessages(): boolean {
    return this.history.hasPreviousMessages();
  }

  public async retrySendMessage(message: MessageData): Promise<void> {
    this.sendMessage(message.message, message.type, message.targetMessageId, message.id);
  }

  private getSignature(message: string): string {
    const { ownAddress: address, privateKey, nickname } = this.userDetails;

    const ownAddress = new EthAddress(address).toString();

    const signer = new PrivateKey(privateKey);
    const signerAddress = signer.publicKey().address().toString();

    if (signerAddress !== ownAddress) {
      throw new Error('The provided address does not match the address derived from the private key');
    }

    const timestamp = Date.now();
    const signature = signer.sign(JSON.stringify({ username: nickname, address: ownAddress, message, timestamp }));

    return signature.toHex();
  }

  private stopMessagesFetchProcess(): void {
    this.stopFetch = true;
  }
}
