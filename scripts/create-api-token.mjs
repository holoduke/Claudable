#!/usr/bin/env node
/**
 * Create a personal API token for a (service) account, e.g. the Slack "Hub" bot:
 *   docker exec claudable node scripts/create-api-token.mjs --email hub-bot@newstory.nl --name "Slack Hub" [--days 365] [--create-user --org <orgId>]
 * Prints the token once, on stdout: run it interactively and do not pipe or log the output. Same format and checks as tokens made in Settings → Account (lib/auth/api-token.ts):
 * the account only reaches projects it is a member of, and a token never has admin rights.
 */
import path from 'path';
import { createHmac, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const email = String(args.email || '').toLowerCase();
const name = String(args.name || 'API token').slice(0, 80);
const days = Number(args.days || 365);
const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
if (!email || !secret || !(days >= 1 && days <= 365)) {
  console.error('usage: create-api-token.mjs --email <user> --name <label> [--days 1-365] [--create-user --org <orgId>] (needs AUTH_SECRET)');
  process.exit(2);
}
// Same database resolution as lib/db/client.ts (relative file: URLs are anchored at prisma/).
const raw = (process.env.DATABASE_URL || '').replace(/^file:/, '');
if (!raw) { console.error('DATABASE_URL is not configured'); process.exit(2); }
const dbFile = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), 'prisma', raw);
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbFile}` }) });
let user = await prisma.user.findUnique({ where: { email } });
if (!user && args['create-user']) {
  const orgId = String(args.org || '');
  const org = orgId && (await prisma.organization.findUnique({ where: { id: orgId } }));
  if (!org) { console.error('--create-user needs --org <existing organisation id>'); process.exit(2); }
  user = await prisma.user.create({ data: { email, name: String(args['user-name'] || 'Hub (Slack bot)'), role: 'user', orgId: org.id } });
  await prisma.orgMember.create({ data: { orgId: org.id, userId: user.id, role: 'lid' } });
  console.error(`created user ${email} in organisation ${org.name}`);
}
if (!user || !user.isActive) { console.error(`no active user ${email}`); process.exit(1); }
const id = randomBytes(18).toString('base64url');
const sig = createHmac('sha256', secret).update(`api-token:${id}`).digest('base64url');
const expiresAt = new Date(Date.now() + days * 86400_000);
await prisma.apiToken.create({ data: { id, userId: user.id, name, expiresAt } });
await prisma.auditEvent.create({
  data: {
    orgId: user.orgId, actorId: null, actorEmail: 'scripts/create-api-token.mjs', action: 'user.api_token.created',
    targetType: 'api_token', targetId: id, meta: JSON.stringify({ name, expiresAt, forUser: email }),
  },
});
console.log(`clb_${id}.${sig}`);
await prisma.$disconnect();
