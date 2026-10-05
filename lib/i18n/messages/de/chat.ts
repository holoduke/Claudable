import type { chatEn } from '../en/chat';
import { chatLogDe } from './chat-log';
import { chatInputDe } from './chat-input';
import { chatEditDe } from './chat-edit';
import { chatStatusDe } from './chat-status';
import { chatPanelsDe } from './chat-panels';

/** DE strings for the chat area — same keys as en/chat.ts. */
export const chatDe: Record<keyof typeof chatEn, string> = {
  ...chatLogDe,
  ...chatInputDe,
  ...chatEditDe,
  ...chatStatusDe,
  ...chatPanelsDe,
};
