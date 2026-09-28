import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ratelimits-'));
process.env.PROJECTS_DIR = path.join(ROOT, 'projects');
let customer = false;
vi.mock('@/lib/db/client', () => ({ prisma: {} }));
vi.mock('@/lib/services/tenant-policy', () => ({ isCustomerProject: async () => customer }));
vi.mock('./stream', () => ({ streamManager: { publish: () => {} } }));
const { recordRateLimit } = await import('./agent-usage');
const FILE = path.join(ROOT, '.claude-rate-limits.json');
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const EVENT = { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.07, resetsAt: 1790560800 }, seven_day: { utilization: 0.2, resetsAt: 1790917200 } } };
const waitForFile = async () => { for (let i = 0; i < 50 && !fs.existsSync(FILE); i++) await new Promise((r) => setTimeout(r, 20)); };

describe('recordRateLimit', () => {
  it('records the FIRST event of a never-seen project (cold tenant cache) and persists it', async () => {
    await recordRateLimit('brand-new-project', EVENT);
    await waitForFile();
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    expect(saved.fiveHour.utilization).toBe(0.07);
    expect(saved.sevenDay.utilization).toBe(0.2);
  });

  it('never records events from a customer project (their own account)', async () => {
    customer = true;
    await recordRateLimit('customer-project', { ...EVENT, unifiedWindows: { five_hour: { utilization: 0.99 } } });
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8')).fiveHour.utilization).toBe(0.07);
  });
});
