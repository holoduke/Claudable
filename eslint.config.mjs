/**
 * ESLint 10 flat config. Replaces eslint-config-next, whose bundled
 * eslint-plugin-react / jsx-a11y / import plugins stop at ESLint 9. Same coverage
 * from plugins that support ESLint 10:
 *   @next/eslint-plugin-next  — Next.js + Core Web Vitals rules
 *   eslint-plugin-react-hooks — rules of hooks + React Compiler checks
 *   @eslint-react             — React correctness (successor of eslint-plugin-react)
 *   jsx-a11y-x / import-x     — maintained forks of jsx-a11y / import
 *   typescript-eslint         — the TS parser (needs the TS 6 API: `typescript`
 *                               is aliased to @typescript/typescript6, see package.json)
 */
import eslintReact from '@eslint-react/eslint-plugin';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig, globalIgnores } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import jsxA11y from 'eslint-plugin-jsx-a11y-x';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const CODE = ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'];

export default defineConfig([
  globalIgnores([
    '.next/**',
    'node_modules/**',
    'data/**',
    'public/**',
    'stubs/**',
    'next-env.d.ts',
  ]),
  {
    files: CODE,
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    files: CODE,
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks, 'import-x': importX, 'jsx-a11y-x': jsxA11y },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      ...reactHooks.configs['recommended-latest'].rules,
      'import-x/no-anonymous-default-export': 'warn',
      'jsx-a11y-x/alt-text': ['warn', { elements: ['img'], img: ['Image'] }],
      'jsx-a11y-x/aria-props': 'warn',
      'jsx-a11y-x/aria-proptypes': 'warn',
      'jsx-a11y-x/aria-unsupported-elements': 'warn',
      'jsx-a11y-x/role-has-required-aria-props': 'warn',
      'jsx-a11y-x/role-supports-aria-props': 'warn',
      // React Compiler rules flag ~90 pre-existing call sites: visible as
      // warnings until those hooks are refactored.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
  {
    files: ['**/*.{jsx,tsx}'],
    ...eslintReact.configs['recommended-typescript'],
  },
  {
    // Hooks rules come from eslint-plugin-react-hooks above; no duplicates.
    files: ['**/*.{jsx,tsx}'],
    ...eslintReact.configs['disable-conflict-eslint-plugin-react-hooks'],
  },
]);
