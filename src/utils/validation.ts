import { Signature } from '@ethersphere/bee-js';
import { MessageData } from '@solarpunkltd/comment-system';
import { Binary } from 'cafe-utility';

import { Logger } from './logger';

const logger = Logger.getInstance();

export function validateUserSignature(data: MessageData): boolean {
  if (data.isLegacy) {
    logger.debug('Legacy user comment detected, skipping signature validation');
    return true;
  }

  try {
    const message = {
      username: data.username,
      address: data.address,
      timestamp: data.timestamp,
      message: data.message,
    };

    const ENCODER = new TextEncoder();
    const digest = Binary.concatBytes(
      ENCODER.encode(`\x19Ethereum Signed Message:\n32`),
      Binary.keccak256(ENCODER.encode(JSON.stringify(message))),
    );

    const isValidSig = data.signature !== undefined && new Signature(data.signature).isValid(digest, data.address);

    if (!isValidSig) {
      throw new Error('Signature verification failed!');
    }

    return true;
  } catch (error) {
    logger.warn('Error in validateUserSignature', error);
    return false;
  }
}
