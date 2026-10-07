"use client";
// Sender of a user chat message (metadata.author, set by the act route):
// small avatar next to the bubble and the name under it.
import { useState } from 'react';

export type MessageAuthorInfo = { id?: string; name?: string | null; email?: string; image?: string | null };

export function authorOf(message: { metadata?: unknown }): MessageAuthorInfo | null {
  const a = (message.metadata as { author?: MessageAuthorInfo } | null | undefined)?.author;
  return a && (a.name || a.email) ? a : null;
}

export const authorLabel = (a: MessageAuthorInfo): string => (a.name && a.name.trim()) || (a.email ? a.email.split('@')[0]! : '');

export const authorInitials = (a: MessageAuthorInfo): string =>
  authorLabel(a).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/** Small round avatar: profile photo, else initials. */
export function AuthorAvatar({ author }: { author: MessageAuthorInfo }) {
  const [broken, setBroken] = useState(false);
  const label = authorLabel(author);
  return author.image && !broken ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={author.image}
      alt=""
      title={label}
      width={24}
      height={24}
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className="w-6 h-6 rounded-full object-cover shrink-0 mt-0.5"
    />
  ) : (
    <span
      title={label}
      aria-hidden="true"
      className="w-6 h-6 rounded-full shrink-0 mt-0.5 flex items-center justify-center text-[10px] font-semibold bg-brand-500/15 text-brand-700 dark:bg-brand-400/20 dark:text-brand-200"
    >
      {authorInitials(author)}
    </span>
  );
}
