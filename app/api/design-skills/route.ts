/**
 * GET /api/design-skills — the design catalog (id, name, description, preview).
 */
import { listDesignCatalog } from '@/lib/services/design-skills';
import { createSuccessResponse, handleApiError } from '@/lib/utils/api-response';

export const runtime = 'nodejs';

export async function GET() {
  try {
    return createSuccessResponse(await listDesignCatalog());
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to load design catalog');
  }
}
