import fs from 'fs/promises';
import path from 'path';

async function writeFileIfMissing(filePath: string, contents: string) {
  try {
    await fs.access(filePath);
    return;
  } catch {
    // continue
  }
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

/**
 * Scaffold a minimal Nuxt 4 + Nuxt UI app.
 * (Kept the historical export name so existing imports keep working.)
 */
export async function scaffoldBasicNextApp(
  projectPath: string,
  projectId: string
) {
  await fs.mkdir(projectPath, { recursive: true });

  const packageJson = {
    name: projectId,
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: {
      dev: 'node scripts/run-dev.js',
      build: 'nuxt build',
      generate: 'nuxt generate',
      preview: 'nuxt preview',
      postinstall: 'nuxt prepare',
    },
    dependencies: {
      nuxt: 'latest',
      '@nuxt/ui': 'latest',
    },
    devDependencies: {
      typescript: '^5.7.2',
    },
  };

  await writeFileIfMissing(
    path.join(projectPath, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'nuxt.config.ts'),
    `// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: true },
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
});
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'tsconfig.json'),
    `{
  "extends": "./.nuxt/tsconfig.json"
}
`
  );

  // Nuxt UI v4 uses Tailwind v4 via its own Vite plugin.
  await writeFileIfMissing(
    path.join(projectPath, 'assets/css/main.css'),
    `@import "tailwindcss";
@import "@nuxt/ui";
`
  );

  // Nuxt UI requires the app wrapped in <UApp>.
  await writeFileIfMissing(
    path.join(projectPath, 'app.vue'),
    `<template>
  <UApp>
    <NuxtPage />
  </UApp>
</template>
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'pages/index.vue'),
    `<template>
  <UContainer class="flex min-h-screen flex-col items-center justify-center gap-6 py-24 text-center">
    <h1 class="text-4xl font-bold sm:text-6xl">Welcome to Nuxt</h1>
    <p class="text-lg text-(--ui-text-muted)">
      Start building by editing <code>pages/index.vue</code>.
    </p>
    <UButton to="https://ui.nuxt.com" target="_blank" size="lg" icon="i-lucide-arrow-up-right">
      Nuxt UI docs
    </UButton>
  </UContainer>
</template>
`
  );

  // Local PostCSS config shadows any inherited (parent) Tailwind config so the
  // project's CSS is processed in isolation.
  await writeFileIfMissing(
    path.join(projectPath, 'postcss.config.js'),
    `module.exports = { plugins: {} };\n`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'scripts/run-dev.js'),
    `#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

function resolvePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if ((a === '--port' || a === '-p') && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (!Number.isNaN(n)) return n;
    } else if (a.startsWith('--port=')) {
      const n = Number.parseInt(a.slice(7), 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  for (const c of [process.env.PORT, process.env.WEB_PORT, process.env.PREVIEW_PORT_START]) {
    const n = Number.parseInt(String(c), 10);
    if (!Number.isNaN(n) && n > 0 && n <= 65535) return n;
  }
  return 3100;
}

const port = resolvePort(process.argv.slice(2));
const host = process.env.PREVIEW_BIND_HOST || '0.0.0.0';
const url = process.env.NEXT_PUBLIC_APP_URL || \`http://localhost:\${port}\`;

console.log(\`🚀 Starting Nuxt dev server on \${url}\`);

// Nuxt uses --host (not --hostname); ignore other passthrough flags.
const child = spawn(
  'npx',
  ['nuxt', 'dev', '--port', String(port), '--host', host],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: isWindows,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: host,
      NITRO_PORT: String(port),
      NITRO_HOST: host,
      NUXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_APP_URL: url,
    },
  }
);

child.on('exit', (code) => {
  if (typeof code === 'number' && code !== 0) {
    console.error(\`❌ Nuxt dev server exited with code \${code}\`);
    process.exit(code);
  }
});

child.on('error', (error) => {
  console.error('❌ Failed to start Nuxt dev server');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
`
  );
}
