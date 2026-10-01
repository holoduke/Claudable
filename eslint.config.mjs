import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  globalIgnores([
    '.next/**',
    'node_modules/**',
    'data/**',
    'public/**',
    'stubs/**',
  ]),
  nextVitals,
  {
    // New react-hooks v6 rules arrived as errors with eslint-config-next 16
    // and flag ~90 pre-existing call sites. Kept visible as warnings until
    // the hooks are refactored (tracked as follow-up, not part of the
    // dependency upgrade).
    // Same file set as the config that registers the react-hooks plugin;
    // without it these rules also hit .cjs files, where the plugin is unknown.
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
    },
  },
]);
