/**
 * Tenant policy: what a project in a CUSTOMER organisation (Organization.type
 * 'klant') may and may not do. Customer projects are worked on by people outside
 * New Story, so everything the agent or the customer can write (package.json,
 * preview.json, .git, symlinks, …) is treated as hostile on the control plane:
 *
 *  - project code never runs in the Claudable process (no npm install / predev /
 *    in-process dev server) — only inside the isolated preview container;
 *  - the agent always runs on the organisation's own credential, never on a
 *    person's or New Story's platform token, and within the org's monthly budget;
 *  - New Story-internal shared resources (org-less MCP servers, plugin
 *    marketplaces, remote design projects) are not attached.
 *
 * Internal (intern) organisations keep the existing behaviour.
 */
import { prisma } from '@/lib/db/client';

export const CUSTOMER_ORG_TYPE = 'klant';

export interface ProjectTenant {
  orgId: string | null;
  isCustomer: boolean;
}

/** The project's organisation and whether it is a customer organisation. */
export async function projectTenant(projectId: string): Promise<ProjectTenant> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { orgId: true, organization: { select: { type: true } } },
  });
  return {
    orgId: project?.orgId ?? null,
    isCustomer: project?.organization?.type === CUSTOMER_ORG_TYPE,
  };
}

export async function isCustomerProject(projectId: string): Promise<boolean> {
  return (await projectTenant(projectId)).isCustomer;
}

/** Thrown when a customer project would have to run code outside its sandbox. */
export class TenantPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantPolicyError';
  }
}
