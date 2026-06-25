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
      '@nuxt/image': 'latest',
      '@nuxt/fonts': 'latest',
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
  // @nuxt/ui: components + theming. @nuxt/image: optimized responsive images.
  // @nuxt/fonts: automatic, performant web-font loading.
  modules: ['@nuxt/ui', '@nuxt/image', '@nuxt/fonts'],
  css: ['~/assets/css/main.css'],
  // SSR is on by default — content ends up in the server-rendered HTML for SEO.
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      titleTemplate: '%s · Nuxt App',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'Built with Nuxt 4 and Nuxt UI.' },
      ],
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    },
  },
  // Allow the managed preview proxy host (Vite dev blocks unknown hosts otherwise)
  vite: { server: { allowedHosts: true } },
});
`
  );

  // Theme baseline: a single place to set the brand color + UI defaults so the
  // whole app stays visually coherent (light/dark handled by Nuxt UI tokens).
  await writeFileIfMissing(
    path.join(projectPath, 'app.config.ts'),
    `export default defineAppConfig({
  ui: {
    colors: {
      primary: 'indigo',
      neutral: 'slate',
    },
  },
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
    `<script setup lang="ts">
useSeoMeta({
  title: 'Home',
  description: 'A beautiful starting point built with Nuxt 4 and Nuxt UI.',
  ogTitle: 'Nuxt App',
  ogDescription: 'A beautiful starting point built with Nuxt 4 and Nuxt UI.',
})

const features = [
  { icon: 'i-lucide-rocket', title: 'Fast by default', description: 'Server-rendered, optimized images and fonts out of the box.' },
  { icon: 'i-lucide-palette', title: 'Beautiful UI', description: 'Nuxt UI components with light & dark mode and a coherent theme.' },
  { icon: 'i-lucide-search', title: 'SEO ready', description: 'Per-page metadata and SSR content for great discoverability.' },
]
</script>

<template>
  <div>
    <UContainer class="flex flex-col items-center gap-6 py-24 text-center sm:py-32">
      <UBadge variant="subtle" size="lg">Built with Nuxt 4 + Nuxt UI</UBadge>
      <h1 class="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">
        Start building something beautiful
      </h1>
      <p class="max-w-xl text-lg text-(--ui-text-muted)">
        Edit <code>pages/index.vue</code> to make it yours. This starter ships
        with theming, responsive images, optimized fonts and SEO defaults.
      </p>
      <div class="flex flex-wrap items-center justify-center gap-3">
        <UButton size="lg" trailing-icon="i-lucide-arrow-right">Get started</UButton>
        <UButton to="https://ui.nuxt.com" target="_blank" size="lg" variant="ghost">
          Nuxt UI docs
        </UButton>
      </div>
    </UContainer>

    <UContainer class="pb-24">
      <div class="grid gap-6 sm:grid-cols-3">
        <UCard v-for="f in features" :key="f.title">
          <div class="flex flex-col gap-2">
            <UIcon :name="f.icon" class="size-6 text-(--ui-primary)" />
            <h3 class="text-lg font-semibold">{{ f.title }}</h3>
            <p class="text-(--ui-text-muted)">{{ f.description }}</p>
          </div>
        </UCard>
      </div>
    </UContainer>
  </div>
</template>
`
  );

  // NOTE: no postcss.config.js — Nuxt manages PostCSS via nuxt.config and warns
  // if a file-based config is present; Nuxt UI uses its own Tailwind Vite plugin.

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
