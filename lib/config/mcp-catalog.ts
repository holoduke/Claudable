/**
 * Catalog of PREDEFINED MCP servers a project can add with one click (like the
 * connector directory in the Claude apps). Two sources, merged:
 *   - CURATED: well-known public remote MCP servers, maintained here.
 *   - COMPANY: admin-managed entries from data/mcp-catalog.json (optional file,
 *     same shape). These are "enabled by your company" and listed first.
 * Entries are just presets — adding one creates a normal per-project MCP server
 * (lib/services/project-mcp), so all validation/OAuth/secrets handling applies.
 */
import { promises as fs } from 'fs';
import path from 'path';

export interface McpCatalogEntry {
  /** Server key, becomes the project server name (a–z, 0–9, -, _). */
  name: string;
  label: string;
  description: string;
  transport: 'http' | 'sse';
  url: string;
  /** 'oauth' servers show an Authenticate button after adding. */
  authType: 'none' | 'oauth';
  /** 'company' = from data/mcp-catalog.json, 'curated' = shipped with Claudable. */
  source: 'company' | 'curated';
}

const CURATED: Omit<McpCatalogEntry, 'source'>[] = [
  { name: 'relume', label: 'Relume Library', description: 'Site maps and wireframes from the Relume component library.', transport: 'http', url: 'https://relume-library-mcp.relume.io/mcp', authType: 'oauth' },
  { name: 'context7', label: 'Context7', description: 'Up-to-date docs and code examples for any library or framework.', transport: 'http', url: 'https://mcp.context7.com/mcp', authType: 'none' },
  { name: 'deepwiki', label: 'DeepWiki', description: 'Ask questions about any public GitHub repository.', transport: 'http', url: 'https://mcp.deepwiki.com/mcp', authType: 'none' },
  { name: 'github', label: 'GitHub', description: 'Repos, issues and pull requests via the official GitHub MCP server.', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', authType: 'oauth' },
  { name: 'sentry', label: 'Sentry', description: 'Query errors and performance issues from your Sentry projects.', transport: 'http', url: 'https://mcp.sentry.dev/mcp', authType: 'oauth' },
  { name: 'linear', label: 'Linear', description: 'Read and manage Linear issues and projects.', transport: 'http', url: 'https://mcp.linear.app/mcp', authType: 'oauth' },
  { name: 'notion', label: 'Notion', description: 'Search and edit pages in your Notion workspace.', transport: 'http', url: 'https://mcp.notion.com/mcp', authType: 'oauth' },
  { name: 'stripe', label: 'Stripe', description: 'Stripe API access — products, payments, customers, docs.', transport: 'http', url: 'https://mcp.stripe.com', authType: 'oauth' },
  { name: 'huggingface', label: 'Hugging Face', description: 'Search models, datasets and papers on the Hugging Face Hub.', transport: 'http', url: 'https://huggingface.co/mcp', authType: 'none' },
  { name: 'cloudflare-docs', label: 'Cloudflare Docs', description: 'Search the Cloudflare developer documentation.', transport: 'sse', url: 'https://docs.mcp.cloudflare.com/sse', authType: 'none' },
];

const COMPANY_CATALOG_FILE = path.join(process.cwd(), 'data', 'mcp-catalog.json');

function isValidEntry(e: unknown): e is Omit<McpCatalogEntry, 'source'> {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.name === 'string' && /^[a-z0-9_-]{1,40}$/.test(o.name) &&
    typeof o.label === 'string' &&
    typeof o.url === 'string' && o.url.startsWith('https://') &&
    (o.transport === 'http' || o.transport === 'sse') &&
    (o.authType === 'none' || o.authType === 'oauth' || o.authType === undefined)
  );
}

async function readCompanyCatalog(): Promise<McpCatalogEntry[]> {
  try {
    const raw = await fs.readFile(COMPANY_CATALOG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.servers) ? parsed.servers : [];
    return list.filter(isValidEntry).map((e: Omit<McpCatalogEntry, 'source'>) => ({
      name: e.name,
      label: e.label,
      description: e.description ?? '',
      transport: e.transport,
      url: e.url,
      authType: e.authType ?? 'none',
      source: 'company' as const,
    }));
  } catch {
    return []; // no file / unreadable → no company entries
  }
}

/** Company entries first; a company entry overrides a curated one with the same name. */
export async function getMcpCatalog(): Promise<McpCatalogEntry[]> {
  const company = await readCompanyCatalog();
  const companyNames = new Set(company.map((e) => e.name));
  const curated = CURATED.filter((e) => !companyNames.has(e.name)).map((e) => ({ ...e, source: 'curated' as const }));
  return [...company, ...curated];
}
