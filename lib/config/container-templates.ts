/**
 * Container TEMPLATES — the data-defined catalog of services a project can add.
 *
 * A template is pure DATA (image + alias + ports + how to template its env and
 * what env it injects into the app). Adding a new kind of service — a cache, a
 * search engine, a queue, an object store — is a new ENTRY here, not new code.
 * The runtime (managed-containers.ts) knows only a few generic mechanics:
 *  - `secrets`: which credential set to generate (postgres/mysql/none) — the ONLY
 *    code-side knowledge, because generating a password can't live in JSON.
 *  - `containerEnv`: env for the container itself, templated with the generated
 *    creds + {alias}/{port}.
 *  - `injectEnv`: env injected into the APP + agent (e.g. DATABASE_URL, REDIS_URL),
 *    templated the same way — so a new service exposes its connection string with
 *    zero changes to the preview/agent wiring.
 *
 * Projects are NOT limited to these — a fully CUSTOM container (any image, alias,
 * env, ports, volume) is added the same way with no template at all.
 */

export type SecretKind = 'postgres' | 'mysql' | 'none';

export interface ContainerTemplate {
  id: string;                         // 'postgres', 'redis', …
  name: string;
  description: string;
  image: string;
  alias: string;                      // default DNS alias on the project net
  kind: string;                       // free-form: 'database' | 'cache' | 'storage' | …
  icon?: string;                      // emoji for the UI
  port?: number;                      // primary port (informational)
  mountPath?: string;                 // if set, a persistent named volume is mounted here
  secrets?: SecretKind;               // credential set to generate (default 'none')
  containerEnv?: Record<string, string>; // env for the container, templated
  injectEnv?: Record<string, string>;    // env injected into the app/agent, templated
  // Readiness check (docker HEALTHCHECK, shell form, templated) — lets the app +
  // agent wait until the service actually accepts connections before using it.
  healthCmd?: string;
  // Linux capabilities to ADD back on top of `--cap-drop ALL` (managed containers
  // run capless by default; a DB image's entrypoint needs a few for initdb/chown).
  capAdd?: string[];
  memory?: string;
  cpus?: string;
}

// Caps a Postgres/MySQL image's root entrypoint needs before it drops to its own
// user (chown/chmod the data dir + su-exec). Everything else stays dropped.
const DB_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'];

/**
 * Template placeholders resolved at provision time:
 *   {alias} {port} {user} {pass} {db}
 * ({user}/{pass}/{db} exist only when `secrets` generates them.)
 */
export const CONTAINER_TEMPLATES: ContainerTemplate[] = [
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'Postgres 16 with pgvector. A dedicated database on this project’s private network, persistent.',
    image: 'pgvector/pgvector:pg16',
    alias: 'db',
    kind: 'database',
    icon: '🐘',
    port: 5432,
    mountPath: '/var/lib/postgresql/data',
    secrets: 'postgres',
    containerEnv: { POSTGRES_USER: '{user}', POSTGRES_PASSWORD: '{pass}', POSTGRES_DB: '{db}' },
    injectEnv: { DATABASE_URL: 'postgresql://{user}:{pass}@{alias}:{port}/{db}' },
    healthCmd: 'pg_isready -U {user} -d {db}',
    capAdd: DB_CAPS,
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'MySQL 8. A dedicated database on this project’s private network, persistent.',
    image: 'mysql:8',
    alias: 'db',
    kind: 'database',
    icon: '🐬',
    port: 3306,
    mountPath: '/var/lib/mysql',
    secrets: 'mysql',
    containerEnv: {
      MYSQL_USER: '{user}', MYSQL_PASSWORD: '{pass}', MYSQL_DATABASE: '{db}',
      // MYSQL_ROOT_PASSWORD is required by the image; reuse the generated password.
      MYSQL_ROOT_PASSWORD: '{pass}',
    },
    injectEnv: { DATABASE_URL: 'mysql://{user}:{pass}@{alias}:{port}/{db}' },
    healthCmd: 'mysqladmin ping -h 127.0.0.1 -u{user} -p{pass} --silent',
    capAdd: DB_CAPS,
  },
  {
    id: 'redis',
    name: 'Redis',
    description: 'Redis 7 cache / key-value store on this project’s private network.',
    image: 'redis:7-alpine',
    alias: 'cache',
    kind: 'cache',
    icon: '⚡',
    port: 6379,
    injectEnv: { REDIS_URL: 'redis://{alias}:{port}' },
    healthCmd: 'redis-cli ping',
  },
  {
    id: 'mongo',
    name: 'MongoDB',
    description: 'MongoDB 7 document database on this project’s private network, persistent.',
    image: 'mongo:7',
    alias: 'mongo',
    kind: 'database',
    icon: '🍃',
    port: 27017,
    mountPath: '/data/db',
    injectEnv: { MONGO_URL: 'mongodb://{alias}:{port}' },
    healthCmd: "mongosh --quiet --eval 'db.runCommand({ping:1}).ok'",
    capAdd: DB_CAPS,
  },
];

export function getContainerTemplate(id: string | null | undefined): ContainerTemplate | undefined {
  return id ? CONTAINER_TEMPLATES.find((t) => t.id === id) : undefined;
}
