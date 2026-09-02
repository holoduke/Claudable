import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addedToOrgEmail, inviteEmail, mailEnabled, sendMail } from './mail';

const ENV = { ...process.env };

beforeEach(() => {
  delete process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_DOMAIN;
  delete process.env.MAILGUN_REGION;
  delete process.env.MAIL_FROM;
  delete process.env.MAIL_REPLY_TO;
  process.env.NEXT_PUBLIC_APP_URL = 'https://claudable.example.test';
});
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

describe('mailer configuration', () => {
  it('is disabled without an API key and resolves sends as not-sent, never throws', async () => {
    expect(mailEnabled()).toBe(false);
    const r = await sendMail({ to: 'a@b.nl', subject: 's', text: 't' });
    expect(r).toEqual({ sent: false, reason: 'disabled' });
  });

  it('posts to the EU endpoint with basic auth and the configured sender', async () => {
    process.env.MAILGUN_API_KEY = 'key-test';
    process.env.MAILGUN_DOMAIN = 'mg.example.test';
    process.env.MAIL_FROM = 'Claudable <noreply@example.test>';
    process.env.MAIL_REPLY_TO = 'support@example.test';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: '<msg-1@mg>' }), { status: 200 }),
    );

    const r = await sendMail({ to: 'a@b.nl', subject: 'Hi', text: 'Hello', tags: ['invite'] });
    expect(r).toEqual({ sent: true, id: '<msg-1@mg>' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.eu.mailgun.net/v3/mg.example.test/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('api:key-test').toString('base64')}`);
    const form = init.body as FormData;
    expect(form.get('from')).toBe('Claudable <noreply@example.test>');
    expect(form.get('to')).toBe('a@b.nl');
    expect(form.get('h:Reply-To')).toBe('support@example.test');
    expect(form.getAll('o:tag')).toEqual(['invite']);
  });

  it('uses the US endpoint when MAILGUN_REGION=us and reports API errors without throwing', async () => {
    process.env.MAILGUN_API_KEY = 'key-test';
    process.env.MAILGUN_DOMAIN = 'mg.example.test';
    process.env.MAILGUN_REGION = 'us';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Forbidden' }), { status: 401 }),
    );
    const r = await sendMail({ to: 'a@b.nl', subject: 's', text: 't' });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://api.mailgun.net/v3/mg.example.test/messages');
    expect(r).toMatchObject({ sent: false, reason: 'error' });
  });
});

describe('templates', () => {
  it('invitation names the org, the role, the address to log in with, and the login link', () => {
    const m = inviteEmail({ to: 'klant@gmail.com', orgName: 'Micros.nl', role: 'eigenaar', invitedBy: 'gillis@newstory.nl', expiresAt: new Date('2026-09-16T00:00:00Z') });
    expect(m.subject).toBe('Uitnodiging voor Micros.nl in Claudable');
    expect(m.text).toContain('Micros.nl');
    expect(m.text).toContain('eigenaar');
    expect(m.text).toContain('klant@gmail.com');
    expect(m.text).toContain('https://claudable.example.test/login');
    expect(m.text).toContain('gillis@newstory.nl');
    expect(m.html).toContain('https://claudable.example.test/login');
    expect(m.html).not.toContain('<script');
  });

  it('escapes HTML in user-controlled fields', () => {
    const m = inviteEmail({ to: 'x@y.nl', orgName: '<b>Evil</b> & Co', role: 'lid', expiresAt: new Date() });
    expect(m.html).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
    expect(m.html).not.toContain('<b>Evil</b>');
  });

  it('added-to-org notice links to the app root', () => {
    const m = addedToOrgEmail({ to: 'x@y.nl', orgName: 'New Story', role: 'lid' });
    expect(m.subject).toContain('New Story');
    expect(m.text).toContain('https://claudable.example.test');
  });
});
