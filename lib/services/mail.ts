/**
 * Outbound e-mail via Mailgun's HTTP API (no SDK; a single authenticated POST).
 *
 * Configuration (all optional — with no MAILGUN_API_KEY the mailer is OFF and
 * every send resolves to { sent: false, reason: 'disabled' } so features like
 * invitations keep working, just without the e-mail):
 *   MAILGUN_API_KEY   Private API key (from the Mailgun dashboard).
 *   MAILGUN_DOMAIN    Sending domain registered in Mailgun, e.g. mg.newstory.tf.
 *   MAILGUN_REGION    'eu' (default — EU data residency) or 'us'.
 *   MAIL_FROM         Sender, e.g. "Claudable <noreply@mg.newstory.tf>".
 *                     Defaults to noreply@<MAILGUN_DOMAIN>.
 *   MAIL_REPLY_TO     Optional reply-to address.
 *
 * Sending is best-effort by design: callers log the outcome (and the audit
 * trail records whether an invitation e-mail went out) but never fail the
 * originating action on a mail error.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /** Mailgun tags for analytics, e.g. ['invite']. */
  tags?: string[];
}

export type MailResult =
  | { sent: true; id: string }
  | { sent: false; reason: 'disabled' | 'error'; error?: string };

function config() {
  const apiKey = process.env.MAILGUN_API_KEY?.trim();
  const domain = process.env.MAILGUN_DOMAIN?.trim();
  if (!apiKey || !domain) return null;
  const region = (process.env.MAILGUN_REGION || 'eu').trim().toLowerCase() === 'us' ? 'us' : 'eu';
  const base = region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
  const from = process.env.MAIL_FROM?.trim() || `Claudable <noreply@${domain}>`;
  const replyTo = process.env.MAIL_REPLY_TO?.trim() || undefined;
  return { apiKey, domain, base, from, replyTo };
}

export function mailEnabled(): boolean {
  return config() !== null;
}

export async function sendMail(msg: MailMessage): Promise<MailResult> {
  const cfg = config();
  if (!cfg) return { sent: false, reason: 'disabled' };

  const form = new FormData();
  form.set('from', cfg.from);
  form.set('to', msg.to);
  form.set('subject', msg.subject);
  form.set('text', msg.text);
  if (msg.html) form.set('html', msg.html);
  const replyTo = msg.replyTo ?? cfg.replyTo;
  if (replyTo) form.set('h:Reply-To', replyTo);
  for (const tag of msg.tags ?? []) form.append('o:tag', tag);

  try {
    const res = await fetch(`${cfg.base}/v3/${cfg.domain}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`api:${cfg.apiKey}`).toString('base64')}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) {
      const error = `Mailgun ${res.status}: ${body.message ?? res.statusText}`;
      console.error('[mail] send failed', msg.to, error);
      return { sent: false, reason: 'error', error };
    }
    return { sent: true, id: body.id ?? '' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('[mail] send failed', msg.to, error);
    return { sent: false, reason: 'error', error };
  }
}

/** Public app URL for links in e-mails (falls back to the auth URL). */
export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL || 'https://claudable.newstory.tf').replace(/\/+$/, '');
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const ROLE_NL: Record<string, string> = { eigenaar: 'eigenaar', beheerder: 'beheerder', lid: 'lid' };

/** Layout shared by the transactional mails: one card, one button, plain footer. */
function layout(title: string, bodyHtml: string, cta: { label: string; url: string }): string {
  return `<!doctype html><html lang="nl"><body style="margin:0;background:#f4f6f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a2126">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #dde3e0;border-radius:8px">
      <tr><td style="padding:28px 32px 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#5a6772">Claudable</td></tr>
      <tr><td style="padding:0 32px 12px;font-size:22px;font-weight:600;line-height:1.3">${esc(title)}</td></tr>
      <tr><td style="padding:0 32px 20px;font-size:15px;line-height:1.55">${bodyHtml}</td></tr>
      <tr><td style="padding:0 32px 28px"><a href="${esc(cta.url)}" style="display:inline-block;background:#1f4e79;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 20px;border-radius:6px">${esc(cta.label)}</a></td></tr>
      <tr><td style="padding:0 32px 24px;font-size:12px;line-height:1.5;color:#5a6772;border-top:1px solid #eef1f0;padding-top:16px">Werkt de knop niet? Kopieer deze link: <span style="word-break:break-all">${esc(cta.url)}</span></td></tr>
    </table>
    <p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#8a949c">Je ontvangt dit bericht omdat iemand je e-mailadres heeft toegevoegd in Claudable, het bouwportaal van New Story.</p>
  </td></tr></table></body></html>`;
}

/** Invitation to join an organisation: log in with this address to accept. */
export function inviteEmail(input: {
  to: string;
  orgName: string;
  role: string;
  invitedBy?: string | null;
  expiresAt: Date;
}): MailMessage {
  const url = `${appUrl()}/login`;
  const role = ROLE_NL[input.role] ?? input.role;
  const by = input.invitedBy ? ` door ${input.invitedBy}` : '';
  const until = input.expiresAt.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
  const text = [
    `Je bent${by} uitgenodigd voor de organisatie "${input.orgName}" in Claudable, als ${role}.`,
    '',
    `Accepteren doe je door in te loggen met je Google-account voor ${input.to}:`,
    url,
    '',
    `De uitnodiging is geldig tot ${until}. Je ziet daarna alleen de projecten van ${input.orgName}.`,
  ].join('\n');
  const html = layout(
    `Uitnodiging voor ${input.orgName}`,
    `<p style="margin:0 0 12px">Je bent${esc(by)} uitgenodigd voor de organisatie <strong>${esc(input.orgName)}</strong> in Claudable, als <strong>${esc(role)}</strong>.</p>
     <p style="margin:0 0 12px">Accepteren doe je door in te loggen met je Google-account voor <strong>${esc(input.to)}</strong>.</p>
     <p style="margin:0;color:#5a6772">Geldig tot ${esc(until)}. Daarna zie je alleen de projecten van ${esc(input.orgName)}.</p>`,
    { label: 'Inloggen en accepteren', url },
  );
  return { to: input.to, subject: `Uitnodiging voor ${input.orgName} in Claudable`, text, html, tags: ['invite'] };
}

/** An existing user was added to (another) organisation. */
export function addedToOrgEmail(input: { to: string; orgName: string; role: string; addedBy?: string | null }): MailMessage {
  const url = appUrl();
  const role = ROLE_NL[input.role] ?? input.role;
  const by = input.addedBy ? ` door ${input.addedBy}` : '';
  const text = [
    `Je bent${by} toegevoegd aan de organisatie "${input.orgName}" in Claudable, als ${role}.`,
    '',
    `De projecten van ${input.orgName} staan nu tussen je projecten:`,
    url,
  ].join('\n');
  const html = layout(
    `Toegevoegd aan ${input.orgName}`,
    `<p style="margin:0 0 12px">Je bent${esc(by)} toegevoegd aan de organisatie <strong>${esc(input.orgName)}</strong> in Claudable, als <strong>${esc(role)}</strong>.</p>
     <p style="margin:0;color:#5a6772">De projecten van ${esc(input.orgName)} staan nu tussen je projecten.</p>`,
    { label: 'Naar Claudable', url },
  );
  return { to: input.to, subject: `Je bent toegevoegd aan ${input.orgName} in Claudable`, text, html, tags: ['org-added'] };
}
