import { describe, expect, it } from 'vitest';
import { extractErrorMessage, isHardBusyError, queueRetryDelayMs, readSendError } from './send-error';

describe('extractErrorMessage', () => {
  it('prefers message, then error, then the status line', () => {
    expect(extractErrorMessage(JSON.stringify({ error: 'forbidden', message: 'Your edit profile does not allow this.' }), 403, 'Forbidden'))
      .toBe('Your edit profile does not allow this.');
    expect(extractErrorMessage(JSON.stringify({ success: false, error: 'This project is being deleted.' }), 409, 'Conflict'))
      .toBe('This project is being deleted.');
    expect(extractErrorMessage(JSON.stringify({ success: false }), 500, 'Internal Server Error')).toBe('500 Internal Server Error');
  });
  it('falls back to the status line for non-JSON / empty bodies', () => {
    expect(extractErrorMessage('<html>Bad Gateway</html>', 502, 'Bad Gateway')).toBe('502 Bad Gateway');
    expect(extractErrorMessage('', 403, '')).toBe('403');
    expect(extractErrorMessage('null', 400, 'Bad Request')).toBe('400 Bad Request');
  });
});

describe('readSendError', () => {
  it('reads the JSON body of a Response', async () => {
    const res = new Response(JSON.stringify({ message: 'busy now' }), { status: 409, statusText: 'Conflict' });
    expect(await readSendError(res)).toBe('busy now');
  });
});

describe('isHardBusyError', () => {
  it('treats a project deletion as permanent and the busy message as transient', () => {
    expect(isHardBusyError('This project is being deleted.')).toBe(true);
    expect(isHardBusyError('The agent is still working on the previous request — wait for it to finish.')).toBe(false);
  });
});

describe('queueRetryDelayMs', () => {
  it('backs off and caps', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(queueRetryDelayMs)).toEqual([1500, 3000, 5000, 8000, 10000, 10000, 10000]);
    expect(queueRetryDelayMs(-1)).toBe(1500);
  });
});
