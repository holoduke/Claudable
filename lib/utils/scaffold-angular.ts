/**
 * Minimal Angular (standalone) starter — a blank canvas the agent builds on.
 * Uses the Angular 18 application builder + Tailwind v3 (Angular auto-detects
 * tailwind.config.js). The `dev` script binds 0.0.0.0 and the preview manager
 * appends `--port <n>`; `--disable-host-check` lets the managed preview proxy
 * reach it.
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

export async function scaffoldAngularApp(projectPath: string, projectId: string) {
  await fs.mkdir(projectPath, { recursive: true });

  const packageJson = {
    name: projectId,
    private: true,
    version: '0.1.0',
    scripts: {
      // --host 0.0.0.0 so the reverse proxy can reach it; the preview manager
      // appends `--port <n>` and (for Angular) `--allowed-hosts <preview-host>`,
      // which the v20 application builder honors (it was a no-op pre-v20).
      dev: 'ng serve --host 0.0.0.0',
      build: 'ng build',
      start: 'ng serve --host 0.0.0.0',
    },
    dependencies: {
      '@angular/animations': '^20.0.0',
      '@angular/common': '^20.0.0',
      '@angular/compiler': '^20.0.0',
      '@angular/core': '^20.0.0',
      '@angular/forms': '^20.0.0',
      '@angular/platform-browser': '^20.0.0',
      '@angular/router': '^20.0.0',
      rxjs: '^7.8.0',
      tslib: '^2.3.0',
      'zone.js': '^0.15.0',
    },
    devDependencies: {
      '@angular-devkit/build-angular': '^20.0.0',
      '@angular/cli': '^20.0.0',
      '@angular/compiler-cli': '^20.0.0',
      typescript: '~5.8.0',
      tailwindcss: '^3.4.0',
      postcss: '^8.4.0',
      autoprefixer: '^10.4.0',
    },
  };
  await writeIfMissing(path.join(projectPath, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);

  await writeIfMissing(
    path.join(projectPath, 'angular.json'),
    `${JSON.stringify(
      {
        $schema: './node_modules/@angular/cli/lib/config/schema.json',
        version: 1,
        newProjectRoot: 'projects',
        projects: {
          app: {
            projectType: 'application',
            root: '',
            sourceRoot: 'src',
            prefix: 'app',
            architect: {
              build: {
                builder: '@angular-devkit/build-angular:application',
                options: {
                  outputPath: 'dist/app',
                  index: 'src/index.html',
                  browser: 'src/main.ts',
                  tsConfig: 'tsconfig.app.json',
                  assets: [],
                  styles: ['src/styles.css'],
                  scripts: [],
                },
                configurations: {
                  production: { optimization: true, outputHashing: 'all' },
                  development: { optimization: false, extractLicenses: false, sourceMap: true },
                },
                defaultConfiguration: 'production',
              },
              serve: {
                builder: '@angular-devkit/build-angular:dev-server',
                configurations: {
                  production: { buildTarget: 'app:build:production' },
                  development: { buildTarget: 'app:build:development' },
                },
                defaultConfiguration: 'development',
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeIfMissing(
    path.join(projectPath, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compileOnSave: false,
        compilerOptions: {
          outDir: './dist/out-tsc',
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          sourceMap: true,
          declaration: false,
          experimentalDecorators: true,
          moduleResolution: 'bundler',
          importHelpers: true,
          target: 'ES2022',
          module: 'ES2022',
          lib: ['ES2022', 'dom'],
        },
        angularCompilerOptions: {
          enableI18nLegacyMessageIdFormat: false,
          strictInjectionParameters: true,
          strictInputAccessModifiers: true,
          strictTemplates: true,
        },
      },
      null,
      2,
    )}\n`,
  );

  await writeIfMissing(
    path.join(projectPath, 'tsconfig.app.json'),
    `${JSON.stringify(
      {
        extends: './tsconfig.json',
        compilerOptions: { outDir: './out-tsc/app', types: [] },
        files: ['src/main.ts'],
        include: ['src/**/*.d.ts'],
      },
      null,
      2,
    )}\n`,
  );

  await writeIfMissing(
    path.join(projectPath, 'tailwind.config.js'),
    `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,ts}'],
  theme: { extend: {} },
  plugins: [],
};
`,
  );

  await writeIfMissing(
    path.join(projectPath, 'src/styles.css'),
    `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
  );

  await writeIfMissing(
    path.join(projectPath, 'src/index.html'),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Angular App</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <app-root></app-root>
  </body>
</html>
`,
  );

  await writeIfMissing(
    path.join(projectPath, 'src/main.ts'),
    `import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent).catch((err) => console.error(err));
`,
  );

  await writeIfMissing(
    path.join(projectPath, 'src/app/app.component.ts'),
    `import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  standalone: true,
  template: \`
    <main class="flex min-h-screen flex-col items-center justify-center gap-4 p-24 text-center">
      <h1 class="text-3xl font-bold tracking-tight">Start building</h1>
      <p class="text-gray-500">Describe what you want and the agent will build it here.</p>
    </main>
  \`,
})
export class AppComponent {}
`,
  );
}
