/**
 * Minimal Next.js (App Router) starter — a blank canvas the agent builds on.
 * Mirrors the Nuxt scaffold's contract: writes only-if-missing, ships a `dev`
 * script that binds 0.0.0.0 and accepts `--port` (the preview manager runs
 * `npm run dev -- --port <n>`), and uses Tailwind v4 for styling.
 */
import fs from 'fs/promises';
import path from 'path';

async function writeIfMissing(filePath: string, contents: string) {
  try {
    await fs.access(filePath);
    return;
  } catch {
    /* create */
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

export async function scaffoldNextApp(projectPath: string, projectId: string) {
  await fs.mkdir(projectPath, { recursive: true });

  const packageJson = {
    name: projectId,
    private: true,
    version: '0.1.0',
    scripts: {
      // -H 0.0.0.0 so the managed preview proxy can reach it; the preview manager
      // appends `--port <n>`.
      dev: 'next dev -H 0.0.0.0',
      build: 'next build',
      start: 'next start -H 0.0.0.0',
      lint: 'next lint',
    },
    dependencies: {
      next: '^15.5.0',
      react: '^19.0.0',
      'react-dom': '^19.0.0',
    },
    devDependencies: {
      typescript: '^5.7.2',
      '@types/node': '^22.0.0',
      '@types/react': '^19.0.0',
      '@types/react-dom': '^19.0.0',
      tailwindcss: '^4.0.0',
      '@tailwindcss/postcss': '^4.0.0',
    },
  };

  await writeIfMissing(path.join(projectPath, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

  await writeIfMissing(
    path.join(projectPath, 'next.config.mjs'),
    `/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`,
  );

  await writeIfMissing(
    path.join(projectPath, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2017',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'preserve',
          incremental: true,
          plugins: [{ name: 'next' }],
          paths: { '@/*': ['./*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null,
      2,
    )}\n`,
  );

  await writeIfMissing(
    path.join(projectPath, 'postcss.config.mjs'),
    `const config = { plugins: { '@tailwindcss/postcss': {} } };
export default config;
`,
  );

  await writeIfMissing(
    path.join(projectPath, 'app/globals.css'),
    `@import "tailwindcss";
`,
  );

  await writeIfMissing(
    path.join(projectPath, 'app/layout.tsx'),
    `import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Next App',
  description: 'Built with Next.js.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
`,
  );

  await writeIfMissing(
    path.join(projectPath, 'app/page.tsx'),
    `export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-24 text-center">
      <h1 className="text-3xl font-bold tracking-tight">Start building</h1>
      <p className="text-gray-500">Describe what you want and the agent will build it here.</p>
    </main>
  );
}
`,
  );
}
