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

import { CommentSettings, CommentSettingsUser } from '../interfaces';
import { remove0x, retryAwaitableAsync } from '../utils/common';
import { ErrorHandler } from '../utils/error';
import { EventEmitter } from '../utils/eventEmitter';

import { DEFAULT_POLL_INTERVAL, EVENTS, FEED_INDEX_ZERO, MINIMUM_POLL_INTERVAL, PLACEHOLDER_STAMP } from './constants';
import { SwarmHistory } from './history';

export class SwarmComment {
  private emitter: EventEmitter;
  private history: SwarmHistory;
  private userDetails: CommentSettingsUser;
  private commentOptions: Options;
  private reactionOptions: Options;

  private signer: PrivateKey;
  private topic: string;

  private errorHandler = ErrorHandler.getInstance();

  private fetchProcessRunning = false;
  private stopFetch = false;
  private reactionIndex = -1n;
  private isSending = false;
  private pollInterval = DEFAULT_POLL_INTERVAL;

  constructor(settings: CommentSettings) {
    this.emitter = new EventEmitter();

    const userSigner = new PrivateKey(remove0x(settings.user.privateKey));
    this.userDetails = {
      privateKey: settings.user.privateKey,
      ownAddress: userSigner.publicKey().address().toString(),
      nickname: settings.user.nickname,
      ownIndex: -1n,
    };

    if (settings.infra.pollInterval && settings.infra.pollInterval < MINIMUM_POLL_INTERVAL) {
      settings.infra.pollInterval = MINIMUM_POLL_INTERVAL;
    }

    //todo: signer not even needed probably, as comment system takes care of it
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

  public start(startIx?: bigint, latestIx?: bigint): void {
    this.init(startIx, latestIx);
    this.startMessagesFetchProcess();
  }

  public stop(): void {
    this.emitter.cleanAll();
    this.stopMessagesFetchProcess();
    this.history.cleanup();
    this.reactionIndex = -1n;
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
          index: nextIndex.toString(),
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

  private async init(startIx?: bigint, latestIx?: bigint, reactionIx?: bigint): Promise<void> {
    try {
      this.emitter.emit(EVENTS.LOADING_INIT, true);

      const [ownIndexResult] = await Promise.allSettled([this.initOwnIndex(latestIx), this.history.init(startIx)]);

      if (ownIndexResult.status === 'rejected') {
        throw ownIndexResult.reason;
      }

      if (reactionIx === undefined) {
        await this.fetchLatestReactions();
      } else {
        this.reactionIndex = reactionIx;
      }

      this.emitter.emit(EVENTS.LOADING_INIT, false);
    } catch (error) {
      this.errorHandler.handleError(error, 'Comment.initSelfState');
      this.emitter.emit(EVENTS.CRITICAL_ERROR, error);
    }
  }

  // TODO: fetch latest index and comment and start to load prev from there
  private async initOwnIndex(latestIx?: bigint): Promise<void> {
    if (latestIx !== undefined) {
      this.userDetails.ownIndex = latestIx;
      return;
    }

    const RETRY_COUNT = 10;
    const DELAY = 1000;

    const comment = await retryAwaitableAsync(
      () => readSingleComment(undefined, this.commentOptions),
      RETRY_COUNT,
      DELAY,
    );

    if (comment?.index) {
      this.userDetails.ownIndex = new FeedIndex(comment.index).toBigInt();
    }
  }

  private async fetchLatestMessage(): Promise<void> {
    if (this.isSending) return;

    try {
      const { data, index } = await this.history.fetchLatestMessage();

      if (this.userDetails.ownIndex < index.toBigInt()) {
        this.userDetails.ownIndex = index.toBigInt();
        this.emitter.emit(EVENTS.MESSAGE_RECEIVED, data);
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

    if(!data){
      return;
    }

    const commentCheck = await readSingleComment(index, this.commentOptions);

    if (!commentCheck) {
      throw new Error('Comment check failed, empty response!');
    }

    if (commentCheck.id !== data.id || commentCheck.timestamp !== data.timestamp) {
      throw new Error(`comment check failed, expected "${data.message}", got: "${commentCheck.message}".
                Expected timestamp: ${data.timestamp}, got: ${commentCheck.timestamp}`);
    }
  }

  private async startMessagesFetchProcess(): Promise<void> {
    if (this.fetchProcessRunning) return;

    this.fetchProcessRunning = true;
    this.stopFetch = false;

    const poll = async () => {
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
