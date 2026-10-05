import type { chatEn } from '../en/chat';
import { chatLogNl } from './chat-log';
import { chatInputNl } from './chat-input';
import { chatEditNl } from './chat-edit';
import { chatStatusNl } from './chat-status';
import { chatPanelsNl } from './chat-panels';

/** NL strings for the chat area — same keys as en/chat.ts. */
export const chatNl: Record<keyof typeof chatEn, string> = {
  ...chatLogNl,
  ...chatInputNl,
  ...chatEditNl,
  ...chatStatusNl,
  ...chatPanelsNl,
};
