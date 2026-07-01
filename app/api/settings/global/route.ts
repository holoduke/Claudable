import { NextRequest, NextResponse } from 'next/server';
import { denyUnlessAdmin, denyUnlessSignedIn } from '@/lib/auth/gate';
import {
  loadGlobalSettings,
  updateGlobalSettings,
  normalizeCliSettings,
} from '@/lib/services/settings';

function serialize(settings: Awaited<ReturnType<typeof loadGlobalSettings>>) {
  return {
    ...settings,
    defaultCli: settings.default_cli,
    cliSettings: settings.cli_settings,
  };
}

export async function GET() {
  // Any signed-in user may read global settings (the app-wide provider fetches
  // this on load); only admins may WRITE. Note: if secret apiKeys are ever
  // stored in cli_settings, redact them here for non-admins.
  const _sg = await denyUnlessSignedIn(); if (_sg) return _sg;
  const settings = await loadGlobalSettings();
  return NextResponse.json(serialize(settings));
}

export async function PUT(request: NextRequest) {
  const _adg = await denyUnlessAdmin(); if (_adg) return _adg;
  try {
    const body = (await request.json().catch(() => null)) ?? {};
    const candidate = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};

    const update: Record<string, unknown> = {};

    const defaultCli = candidate.default_cli ?? candidate.defaultCli;
    if (typeof defaultCli === 'string') {
      update.default_cli = defaultCli;
    }

    const cliSettingsRaw = candidate.cli_settings ?? candidate.cliSettings;
    const cliSettings = normalizeCliSettings(cliSettingsRaw as Record<string, unknown> | undefined);
    if (cliSettings) {
      update.cli_settings = cliSettings;
    }

    const nextSettings = await updateGlobalSettings(update);
    return NextResponse.json(serialize(nextSettings));
  } catch (error) {
    console.error('[API] Failed to update global settings:', error);
    return NextResponse.json(
      {
        error: 'Failed to update global settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
