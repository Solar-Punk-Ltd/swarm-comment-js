import { FeedIndex } from '@ethersphere/bee-js';

export const EVENTS = {
  LOADING_INIT: 'loadingInit',
  LOADING_PREVIOUS_MESSAGES: 'loadingPreviousMessages',
  MESSAGE_RECEIVED: 'messageReceived',
  MESSAGE_REQUEST_INITIATED: 'messageRequestInitiated',
  MESSAGE_REQUEST_UPLOADED: 'messageRequestUploaded',
  MESSAGE_REQUEST_ERROR: 'messageRequestError',
  CRITICAL_ERROR: 'criticalError',
};

export const DEFAULT_POLL_INTERVAL = 2000;
export const MINIMUM_POLL_INTERVAL = 500;
// placeholder stamp if smart gateway is used
export const PLACEHOLDER_STAMP = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const COMMENTS_TO_READ = 9n;
export const FEED_INDEX_ZERO = FeedIndex.fromBigInt(0n);
