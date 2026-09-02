/**
 * POST /api/settings/mail-test  -> { to? }  (superadmin)
 * Sends a test e-mail through the configured Mailgun account so an admin can
 * verify delivery without inviting anyone. GET reports whether mail is enabled.
 */
import { NextRequest } from 'next/server';
import { getAdminUser } from '@/lib/auth/session';
import { mailEnabled, sendMail, appUrl } from '@/lib/services/mail';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);
    return createSuccessResponse({ enabled: mailEnabled(), domain: process.env.MAILGUN_DOMAIN ?? null, region: process.env.MAILGUN_REGION || 'eu' });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to read mail status');
  }
}

export async function POST(request: NextRequest) {
  try {
    const admin = await getAdminUser();
    if (!admin) return createErrorResponse('forbidden', 'Admin access required', 403);
    const body = (await request.json().catch(() => null)) ?? {};
    const to = typeof body.to === 'string' && body.to.includes('@') ? body.to.trim() : admin.email;
    const result = await sendMail({
      to,
      subject: 'Claudable test e-mail',
      text: `Dit is een testbericht vanuit Claudable (${appUrl()}). Als je dit leest, werkt de Mailgun-koppeling.`,
      tags: ['test'],
    });
    if (!result.sent) {
      return createErrorResponse(result.reason === 'disabled' ? 'mail_disabled' : 'mail_error',
        result.reason === 'disabled' ? 'Mail is not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN)' : (result.error ?? 'Send failed'), 502);
    }
    return createSuccessResponse({ to, id: result.id });
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to send test e-mail');
  }
}
