import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#fdf3f0', 100: '#fbe6df', 200: '#f5c9bb', 300: '#eda88f', 400: '#e28a6b', 500: '#DE7356', 600: '#c65f43', 700: '#a54a32', 800: '#833c2a', 900: '#6b3324',
        },
        'bolt-bg-primary': '#0c0a14',
        'bolt-bg-secondary': '#15111e',
        'bolt-bg-tertiary': '#1e1a2a',
        'bolt-border-color': 'rgba(139, 92, 246, 0.2)',
        'bolt-text-primary': '#e5e2ff',
        'bolt-text-secondary': '#a8a4ce',
        'bolt-text-tertiary': '#6b6685',
      },
    },
  },
  plugins: [],
}
export default config
