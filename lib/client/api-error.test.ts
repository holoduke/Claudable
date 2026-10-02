import { describe, it, expect } from 'vitest';
import { apiErrorMessage, responseErrorMessage } from './api-error';

describe('apiErrorMessage', () => {
  it('prefers the human message over the machine code', () => {
    expect(apiErrorMessage({ success: false, error: 'forbidden', message: 'Access denied' }, 'x')).toBe('Access denied');
  });

  it('uses a sentence-like error when there is no message', () => {
    expect(apiErrorMessage({ error: 'Service not found' }, 'x')).toBe('Service not found');
  });

  it('falls back instead of showing a bare code', () => {
    expect(apiErrorMessage({ error: 'action_failed' }, 'Could not save')).toBe('Could not save');
    expect(apiErrorMessage({ error: 'unavailable' }, 'Could not save')).toBe('Could not save');
  });

  it('reads nested error objects', () => {
    expect(apiErrorMessage({ error: { message: 'Token expired' } }, 'x')).toBe('Token expired');
  });

  it('handles empty, null and non-object input', () => {
    expect(apiErrorMessage(null, 'fb')).toBe('fb');
    expect(apiErrorMessage({}, 'fb')).toBe('fb');
    expect(apiErrorMessage({ message: '  ' }, 'fb')).toBe('fb');
    expect(apiErrorMessage('Plain text', 'fb')).toBe('Plain text');
  });
});

describe('responseErrorMessage', () => {
  it('parses JSON bodies', async () => {
    const res = new Response(JSON.stringify({ error: 'forbidden', message: 'Admin access required' }), { status: 403 });
    expect(await responseErrorMessage(res)).toBe('Admin access required');
  });

  it('never returns raw non-JSON bodies', async () => {
    const res = new Response('<html>502</html>', { status: 502 });
    expect(await responseErrorMessage(res)).toBe('Request failed (502)');
    expect(await responseErrorMessage(new Response('', { status: 500 }), 'Nope')).toBe('Nope');
  });
});
