import { chatLogEn } from './chat-log';
import { chatInputEn } from './chat-input';
import { chatEditEn } from './chat-edit';
import { chatStatusEn } from './chat-status';
import { chatPanelsEn } from './chat-panels';

/** English strings for the chat area (merged into ../en.ts). Keys: '<area>.<name>'. */
export const chatEn = {
  ...chatLogEn,
  ...chatInputEn,
  ...chatEditEn,
  ...chatStatusEn,
  ...chatPanelsEn,
} as const;
