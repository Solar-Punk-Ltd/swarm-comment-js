import { Bee } from '@ethersphere/bee-js';

export interface CommentSettings {
  user: {
    privateKey: string;
    nickname: string;
  };
  infra: {
    beeUrl: string;
    stamp?: string;
    topic: string;
    pollInterval?: number;
  };
}

export interface CommentSettingsUser {
  privateKey: string;
  ownAddress: string;
  nickname: string;
  ownIndex: bigint;
}

export interface CommentSettingsSwarm {
  bee: Bee;
  beeUrl: string;
  stamp: string;
  topic: string;
  address: string;
  pollInterval: number;
}
