import { prisma } from '@/lib/db/client';
import type { ProjectServiceConnection } from '@prisma/client';

// updateProjectServiceData is a read-modify-write of a JSON blob, so concurrent
// writers to the same connection (e.g. a PATCH setting the git branch while a
// Sync writes last_synced_at) can lose one update. Serialize per
// (projectId, provider) with an in-process chained-promise lock — single Node
// server, so this fully closes the race without a schema/transaction change.
const serviceDataLocks = new Map<string, Promise<unknown>>();

async function withServiceDataLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = serviceDataLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  serviceDataLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (serviceDataLocks.get(key) === run) {
      serviceDataLocks.delete(key);
    }
  }
}

function serializeServiceData(data: Record<string, unknown>): string {
  return JSON.stringify(data ?? {});
}

function deserializeServiceData(connection: ProjectServiceConnection) {
  try {
    return {
      ...connection,
      serviceData: connection.serviceData ? JSON.parse(connection.serviceData) : {},
    };
  } catch (error) {
    console.error(
      `[ProjectServices] Failed to deserialize service data for connection ${connection.id}:`,
      error instanceof Error ? error.message : 'Unknown error',
      '\nRaw data:',
      connection.serviceData
    );
    return {
      ...connection,
      serviceData: {},
    };
  }
}

export async function listProjectServices(projectId: string) {
  const connections = await prisma.projectServiceConnection.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });

  return connections.map(deserializeServiceData);
}

export async function getProjectService(projectId: string, provider: string) {
  const connection = await prisma.projectServiceConnection.findFirst({
    where: { projectId, provider },
  });

  return connection ? deserializeServiceData(connection) : null;
}

export async function upsertProjectServiceConnection(
  projectId: string,
  provider: string,
  serviceData: Record<string, unknown>
) {
  const existing = await prisma.projectServiceConnection.findFirst({
    where: { projectId, provider },
  });

  if (existing) {
    const updated = await prisma.projectServiceConnection.update({
      where: { id: existing.id },
      data: {
        serviceData: serializeServiceData(serviceData),
        status: 'connected',
      },
    });
    return deserializeServiceData(updated);
  }

  const created = await prisma.projectServiceConnection.create({
    data: {
      projectId,
      provider,
      status: 'connected',
      serviceData: serializeServiceData(serviceData),
    },
  });

  return deserializeServiceData(created);
}

export async function deleteProjectService(serviceId: string, projectId?: string): Promise<boolean> {
  try {
    // Scope by projectId when provided so a valid project gate can't be used to
    // delete another project's service via a foreign service_id (IDOR).
    const result = await prisma.projectServiceConnection.deleteMany({
      where: projectId ? { id: serviceId, projectId } : { id: serviceId },
    });
    return result.count > 0;
  } catch (error) {
    return false;
  }
}

export async function updateProjectServiceData(
  projectId: string,
  provider: string,
  patch: Record<string, unknown>
) {
  return withServiceDataLock(`${projectId}:${provider}`, async () => {
    const existing = await prisma.projectServiceConnection.findFirst({
      where: { projectId, provider },
    });

    const nextData = {
      ...(existing ? (existing.serviceData ? JSON.parse(existing.serviceData) : {}) : {}),
      ...patch,
    };

    if (existing) {
      const updated = await prisma.projectServiceConnection.update({
        where: { id: existing.id },
        data: { serviceData: serializeServiceData(nextData) },
      });
      return deserializeServiceData(updated);
    }

    const created = await prisma.projectServiceConnection.create({
      data: {
        projectId,
        provider,
        status: 'connected',
        serviceData: serializeServiceData(nextData),
      },
    });

    return deserializeServiceData(created);
  });
}
