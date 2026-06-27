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
 * Scaffold a full Nuxt 4 + Nuxt UI app: a default layout with header + footer,
 * shared navigation, and ready-made Home, Pricing, About and Contact pages plus
 * a custom error page — a coherent multi-page starting point rather than a bare
 * single page. All files are written only if missing, so existing projects are
 * never overwritten.
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
    // Caret-pinned to the current majors: new apps get every minor/patch
    // update (stay modern) but won't silently jump to a breaking new major
    // (e.g. Nuxt 5 / Nuxt UI 5) on a fresh install. Bump these deliberately.
    dependencies: {
      nuxt: '^4.4.8',
      '@nuxt/ui': '^4.9.0',
      '@nuxt/image': '^2.0.0',
      '@nuxt/fonts': '^0.14.0',
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

  // Nuxt UI requires the app wrapped in <UApp>. NuxtLayout applies the default
  // layout (header + footer) around every page.
  await writeFileIfMissing(
    path.join(projectPath, 'app.vue'),
    `<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
`
  );

  // Central nav definition shared by the header and footer (auto-imported).
  await writeFileIfMissing(
    path.join(projectPath, 'composables/useNavigation.ts'),
    `export interface NavLink {
  label: string
  to: string
}

export function useNavigation(): NavLink[] {
  return [
    { label: 'Home', to: '/' },
    { label: 'Pricing', to: '/pricing' },
    { label: 'About', to: '/about' },
    { label: 'Contact', to: '/contact' },
  ]
}
`
  );

  // Default layout: sticky header, page content, footer.
  await writeFileIfMissing(
    path.join(projectPath, 'layouts/default.vue'),
    `<template>
  <div class="flex min-h-screen flex-col">
    <AppHeader />
    <main class="flex-1">
      <slot />
    </main>
    <AppFooter />
  </div>
</template>
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'components/AppHeader.vue'),
    `<script setup lang="ts">
const links = useNavigation()
const open = ref(false)
const route = useRoute()
watch(() => route.path, () => { open.value = false })
</script>

<template>
  <header class="sticky top-0 z-50 border-b border-(--ui-border) bg-(--ui-bg)/80 backdrop-blur">
    <UContainer class="flex h-16 items-center justify-between gap-4">
      <NuxtLink to="/" class="flex items-center gap-2 text-lg font-bold">
        <UIcon name="i-lucide-box" class="size-6 text-(--ui-primary)" />
        <span>Acme</span>
      </NuxtLink>

      <nav class="hidden items-center gap-1 md:flex">
        <UButton
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          :label="l.label"
          color="neutral"
          variant="ghost"
        />
      </nav>

      <div class="flex items-center gap-2">
        <UButton to="/contact" label="Get started" class="hidden sm:inline-flex" />
        <UButton
          :icon="open ? 'i-lucide-x' : 'i-lucide-menu'"
          color="neutral"
          variant="ghost"
          class="md:hidden"
          aria-label="Toggle menu"
          @click="open = !open"
        />
      </div>
    </UContainer>

    <div v-if="open" class="border-t border-(--ui-border) md:hidden">
      <UContainer class="flex flex-col gap-1 py-2">
        <UButton
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          :label="l.label"
          color="neutral"
          variant="ghost"
          block
          class="justify-start"
        />
      </UContainer>
    </div>
  </header>
</template>
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'components/AppFooter.vue'),
    `<script setup lang="ts">
const links = useNavigation()
const year = new Date().getFullYear()
</script>

<template>
  <footer class="mt-24 border-t border-(--ui-border)">
    <UContainer class="flex flex-col gap-4 py-10 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-2 font-semibold">
        <UIcon name="i-lucide-box" class="size-5 text-(--ui-primary)" />
        <span>Acme</span>
      </div>
      <nav class="flex flex-wrap gap-x-6 gap-y-2 text-sm text-(--ui-text-muted)">
        <NuxtLink
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          class="transition-colors hover:text-(--ui-text)"
        >
          {{ l.label }}
        </NuxtLink>
      </nav>
      <p class="text-sm text-(--ui-text-muted)">© {{ year }} Acme. All rights reserved.</p>
    </UContainer>
  </footer>
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

    <UContainer class="pb-24">
      <div class="flex flex-col items-center gap-5 rounded-2xl bg-(--ui-bg-elevated) px-6 py-16 text-center">
        <h2 class="text-3xl font-bold tracking-tight sm:text-4xl">Ready to dive in?</h2>
        <p class="max-w-lg text-(--ui-text-muted)">
          Explore the plans or get in touch — this starter already has the pages wired up.
        </p>
        <div class="flex flex-wrap items-center justify-center gap-3">
          <UButton to="/pricing" size="lg" label="See pricing" />
          <UButton to="/contact" size="lg" variant="ghost" label="Contact us" trailing-icon="i-lucide-arrow-right" />
        </div>
      </div>
    </UContainer>
  </div>
</template>
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'pages/about.vue'),
    `<script setup lang="ts">
useSeoMeta({
  title: 'About',
  description: 'Learn more about who we are and what we do.',
})

const values = [
  { icon: 'i-lucide-target', title: 'Focused', description: 'We do a few things and do them exceptionally well.' },
  { icon: 'i-lucide-heart', title: 'Customer-first', description: 'Every decision starts with the people we serve.' },
  { icon: 'i-lucide-sparkles', title: 'Craft', description: 'We sweat the details so the experience feels effortless.' },
]
</script>

<template>
  <div>
    <UContainer class="py-24">
      <div class="max-w-2xl">
        <UBadge variant="subtle" size="lg">About</UBadge>
        <h1 class="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
          We build delightful products
        </h1>
        <p class="mt-6 text-lg text-(--ui-text-muted)">
          Replace this copy with your own story. Tell visitors who you are, why
          you started, and what makes your team different.
        </p>
      </div>
    </UContainer>

    <UContainer class="pb-24">
      <div class="grid gap-6 sm:grid-cols-3">
        <div v-for="v in values" :key="v.title" class="flex flex-col gap-2">
          <UIcon :name="v.icon" class="size-6 text-(--ui-primary)" />
          <h3 class="text-lg font-semibold">{{ v.title }}</h3>
          <p class="text-(--ui-text-muted)">{{ v.description }}</p>
        </div>
      </div>
    </UContainer>
  </div>
</template>
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'pages/pricing.vue'),
    `<script setup lang="ts">
useSeoMeta({
  title: 'Pricing',
  description: 'Simple, transparent pricing for teams of every size.',
})

const tiers = [
  {
    name: 'Starter',
    price: '$0',
    description: 'For trying things out.',
    features: ['1 project', 'Community support', 'Basic analytics'],
    featured: false,
  },
  {
    name: 'Pro',
    price: '$29',
    description: 'For growing teams.',
    features: ['Unlimited projects', 'Priority support', 'Advanced analytics', 'Custom domain'],
    featured: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    description: 'For large organizations.',
    features: ['SSO & SAML', 'Dedicated support', 'SLA', 'Audit logs'],
    featured: false,
  },
]
</script>

<template>
  <UContainer class="py-24">
    <div class="mx-auto max-w-2xl text-center">
      <UBadge variant="subtle" size="lg">Pricing</UBadge>
      <h1 class="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">Plans for every stage</h1>
      <p class="mt-4 text-lg text-(--ui-text-muted)">Start free, upgrade when you are ready.</p>
    </div>

    <div class="mt-16 grid gap-6 lg:grid-cols-3">
      <UCard
        v-for="t in tiers"
        :key="t.name"
        :class="t.featured ? 'ring-2 ring-(--ui-primary)' : ''"
      >
        <div class="flex flex-col gap-4">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-semibold">{{ t.name }}</h3>
            <UBadge v-if="t.featured" color="primary" variant="subtle">Popular</UBadge>
          </div>
          <p class="text-(--ui-text-muted)">{{ t.description }}</p>
          <p class="text-4xl font-bold">{{ t.price }}</p>
          <ul class="flex flex-col gap-2">
            <li v-for="f in t.features" :key="f" class="flex items-center gap-2">
              <UIcon name="i-lucide-check" class="size-4 text-(--ui-primary)" />
              <span class="text-sm">{{ f }}</span>
            </li>
          </ul>
          <UButton
            to="/contact"
            block
            :variant="t.featured ? 'solid' : 'outline'"
            :label="t.price === 'Custom' ? 'Contact sales' : 'Get started'"
          />
        </div>
      </UCard>
    </div>
  </UContainer>
</template>
`
  );

  await writeFileIfMissing(
    path.join(projectPath, 'pages/contact.vue'),
    `<script setup lang="ts">
useSeoMeta({
  title: 'Contact',
  description: 'Get in touch with our team.',
})

const state = reactive({ name: '', email: '', message: '' })
const sent = ref(false)

function onSubmit() {
  // Wire this up to your backend / email provider.
  sent.value = true
}
</script>

<template>
  <UContainer class="py-24">
    <div class="mx-auto max-w-xl">
      <UBadge variant="subtle" size="lg">Contact</UBadge>
      <h1 class="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">Get in touch</h1>
      <p class="mt-3 text-(--ui-text-muted)">
        We would love to hear from you. Fill out the form and we will get back to you.
      </p>

      <UAlert
        v-if="sent"
        class="mt-8"
        color="success"
        variant="subtle"
        icon="i-lucide-check-circle"
        title="Message sent"
        description="Thanks for reaching out — this is a demo form, wire it to your backend."
      />

      <form v-else class="mt-8 flex flex-col gap-4" @submit.prevent="onSubmit">
        <UFormField label="Name">
          <UInput v-model="state.name" placeholder="Your name" class="w-full" />
        </UFormField>
        <UFormField label="Email">
          <UInput v-model="state.email" type="email" placeholder="you@example.com" class="w-full" />
        </UFormField>
        <UFormField label="Message">
          <UTextarea v-model="state.message" :rows="5" placeholder="How can we help?" class="w-full" />
        </UFormField>
        <UButton type="submit" label="Send message" trailing-icon="i-lucide-send" class="self-start" />
      </form>
    </div>
  </UContainer>
</template>
`
  );

  // Custom error page (rendered outside the layout, so it needs its own <UApp>).
  await writeFileIfMissing(
    path.join(projectPath, 'error.vue'),
    `<script setup lang="ts">
import type { NuxtError } from '#app'

const props = defineProps<{ error: NuxtError }>()

useSeoMeta({ title: \`\${props.error.statusCode} — Error\` })
</script>

<template>
  <UApp>
    <UContainer class="flex min-h-screen flex-col items-center justify-center gap-6 text-center">
      <p class="text-6xl font-bold text-(--ui-primary)">{{ error.statusCode }}</p>
      <h1 class="text-2xl font-semibold">Something went wrong</h1>
      <p class="max-w-md text-(--ui-text-muted)">
        {{ error.message || 'The page you are looking for could not be found.' }}
      </p>
      <UButton label="Back home" @click="clearError({ redirect: '/' })" />
    </UContainer>
  </UApp>
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
