import type { chatEn } from '../en/chat';
import { chatLogFr } from './chat-log';
import { chatInputFr } from './chat-input';
import { chatEditFr } from './chat-edit';
import { chatStatusFr } from './chat-status';
import { chatPanelsFr } from './chat-panels';

/** FR strings for the chat area — same keys as en/chat.ts. */
export const chatFr: Record<keyof typeof chatEn, string> = {
  ...chatLogFr,
  ...chatInputFr,
  ...chatEditFr,
  ...chatStatusFr,
  ...chatPanelsFr,
};
