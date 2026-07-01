import { NextRequest } from 'next/server';
import { denyUnlessAdmin } from '@/lib/auth/gate';
import { createServiceToken } from '@/lib/services/tokens';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

export async function POST(request: NextRequest) {
  const _adg = await denyUnlessAdmin(); if (_adg) return _adg;
  try {
    const body = (await request.json().catch(() => null)) ?? {};
    const provider = typeof body?.provider === 'string' ? body.provider : '';
    const token = typeof body?.token === 'string' ? body.token : '';
    const name = typeof body?.name === 'string' ? body.name : '';

    const record = await createServiceToken(provider, token, name);
    return createSuccessResponse(record, 201);
  } catch (error) {
    return handleApiError(error, 'Tokens API', 'Failed to save token');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
