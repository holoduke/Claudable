import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { classifyChange, isAllowed, PROFILES } = require('./classify.cjs');

const kinds = (path: string, before: string | null, after: string | null) => [...classifyChange(path, before, after)].sort();

describe('classifyChange — templates', () => {
  const vue = (h1: string, cls = 'text-4xl font-bold', extra = '') =>
    `<template>\n  <section class="py-20">\n    <h1 class="${cls}"${extra}>${h1}</h1>\n    <p>Welkom {{ user.name }} bij ons</p>\n  </section>\n</template>`;

  it('text between tags is text', () => {
    expect(kinds('pages/index.vue', vue('Hallo'), vue('Goedemorgen'))).toEqual(['text']);
  });
  it('static class/style values are style', () => {
    expect(kinds('pages/index.vue', vue('Hallo'), vue('Hallo', 'text-5xl font-black text-brand-600'))).toEqual(['style']);
  });
  it('both at once', () => {
    expect(kinds('pages/index.vue', vue('Hallo'), vue('Hoi', 'text-5xl'))).toEqual(['style', 'text']);
  });
  it('text around an interpolation is text, the interpolation itself is code', () => {
    const a = vue('X').replace('Welkom {{ user.name }} bij ons', 'Hallo {{ user.name }} en welkom');
    expect(kinds('pages/index.vue', vue('X'), a)).toEqual(['text']);
    const b = vue('X').replace('{{ user.name }}', '{{ user.email }}');
    expect(kinds('pages/index.vue', vue('X'), b)).toEqual(['code']);
  });
  it('directives, handlers and structure are code', () => {
    expect(kinds('pages/index.vue', vue('Hallo'), vue('Hallo', 'text-4xl font-bold', ' v-if="isAdmin"'))).toEqual(['code']);
    const withDir = vue('Hallo', 'text-4xl font-bold', ' v-if="isAdmin"');
    expect(kinds('pages/index.vue', withDir, withDir.replace('isAdmin', 'true'))).toEqual(['code']);
    expect(kinds('pages/index.vue', vue('Hallo'), vue('Hallo').replace('<p>', '<div>').replace('</p>', '</div>'))).toEqual(['code']);
    expect(kinds('pages/index.vue', vue('Hallo'), vue('Hallo').replace('class="py-20"', ':class="dyn"'))).toEqual(['code']);
  });
  it('text attributes (alt, title, label, href) are text; others are code', () => {
    const a = '<img src="/a.png" alt="Oude tekst" id="hero">';
    expect(kinds('components/Hero.vue', a, a.replace('Oude tekst', 'Nieuwe tekst'))).toEqual(['text']);
    expect(kinds('components/Hero.vue', a, a.replace('/a.png', '/b.png'))).toEqual(['text']);
    expect(kinds('components/Hero.vue', a, a.replace('id="hero"', 'id="top"'))).toEqual(['code']);
    const btn = '<UButton label="Bestel" to="/shop" @click="buy" />';
    expect(kinds('components/Cta.vue', btn, btn.replace('Bestel', 'Koop nu'))).toEqual(['text']);
    expect(kinds('components/Cta.vue', btn, btn.replace('buy', 'hack'))).toEqual(['code']);
  });
});

describe('classifyChange — script and JSX', () => {
  const script = (label: string, extra = '') =>
    `<script setup lang="ts">\nimport { ref } from 'vue'\nconst links = [{ label: '${label}', to: '/about' }]\nconst status = 'paid'${extra}\n</script>`;

  it('text-like keys in script data are text', () => {
    expect(kinds('components/Nav.vue', script('Over ons'), script('Wie we zijn'))).toEqual(['text']);
  });
  it('other string literals, imports and logic are code', () => {
    expect(kinds('components/Nav.vue', script('A'), script('A').replace("'paid'", "'free'"))).toEqual(['code']);
    expect(kinds('components/Nav.vue', script('A'), script('A').replace("from 'vue'", "from 'evil'"))).toEqual(['code']);
    expect(kinds('components/Nav.vue', script('A'), script('A', '\nfetch("/api/x")'))).toEqual(['code']);
  });
  it('JSX text is text, JSX expressions are code', () => {
    const tsx = (t: string, e = 'title') => `export default function H() { return <h1 className="text-xl">${t} {${e}}</h1> }`;
    expect(kinds('app/page.tsx', tsx('Hallo'), tsx('Goedendag'))).toEqual(['text']);
    expect(kinds('app/page.tsx', tsx('Hallo'), tsx('Hallo', 'secret'))).toEqual(['code']);
    expect(kinds('app/page.tsx', tsx('Hallo'), tsx('Hallo').replace('text-xl', 'text-2xl'))).toEqual(['style']);
  });
});

describe('classifyChange — files', () => {
  it('css, tailwind and theme config are style', () => {
    expect(kinds('assets/css/main.css', 'a{color:red}', 'a{color:blue}')).toEqual(['style']);
    expect(kinds('tailwind.config.ts', "colors:{a:'#000'}", "colors:{a:'#fff'}")).toEqual(['style']);
    expect(kinds('app/app.config.ts', "ui:{colors:{primary:'green'}}", "ui:{colors:{primary:'blue'}}")).toEqual(['style']);
    expect(kinds('app/app.config.ts', "ui:{colors:{primary:'green'}}", "ui:{colors:{primary:'green'}},api:x()")).toEqual(['code']);
  });
  it('content files and images', () => {
    expect(kinds('content/blog/post.md', '# A', '# B')).toEqual(['text']);
    expect(kinds('locales/nl.json', '{"a":"x"}', '{"a":"y"}')).toEqual(['text']);
    expect(kinds('public/images/hero.webp', 'bin', 'bin2')).toEqual(['asset']);
    expect(kinds('public/images/new.png', null, 'bin')).toEqual(['asset']);
  });
  it('config, server code, packages, new components and deletions are code', () => {
    expect(kinds('nuxt.config.ts', 'a', 'b')).toEqual(['code']);
    expect(kinds('package.json', '{}', '{"x":1}')).toEqual(['code']);
    expect(kinds('server/api/x.ts', "const t = 'a'", "const t = 'b'")).toEqual(['code']);
    expect(kinds('components/New.vue', null, '<template><p>x</p></template>')).toEqual(['code']);
    expect(kinds('components/Old.vue', '<template/>', null)).toEqual(['code']);
    expect(kinds('.env', 'A=1', 'A=2')).toEqual(['code']);
    expect(kinds('.claudable/preview.json', '{}', '{"a":1}')).toEqual(['code']);
  });
  it('unchanged is nothing', () => {
    expect(kinds('pages/index.vue', 'x', 'x')).toEqual([]);
  });
});

describe('isAllowed', () => {
  it('maps kinds onto profiles', () => {
    expect(isAllowed(PROFILES.content, new Set(['text', 'asset']))).toBe(true);
    expect(isAllowed(PROFILES.content, new Set(['style']))).toBe(false);
    expect(isAllowed(PROFILES.style, new Set(['style']))).toBe(true);
    expect(isAllowed(PROFILES.style, new Set(['text']))).toBe(false);
    expect(isAllowed(PROFILES['content-style'], new Set(['text', 'style']))).toBe(true);
    expect(isAllowed(PROFILES['content-style'], new Set(['code']))).toBe(false);
    expect(isAllowed(PROFILES.full, new Set(['code']))).toBe(true);
  });
  it('custom profiles: kinds plus path globs', () => {
    const custom = { id: 'custom', kinds: ['text', 'style'], allowPaths: ['pages/**', 'components/**'], denyPaths: ['components/Checkout.vue'] };
    expect(isAllowed(custom, new Set(['text']), 'pages/index.vue')).toBe(true);
    expect(isAllowed(custom, new Set(['text']), 'layouts/default.vue')).toBe(false);
    expect(isAllowed(custom, new Set(['text']), 'components/Checkout.vue')).toBe(false);
  });
});

describe('classifyChange — hardening', () => {
  it('Angular control flow in html is code', () => {
    const a = '<ul>@for (t of items; track t.id) {<li>{{ t.name }} item</li>}</ul>';
    expect(kinds('src/app/list.component.html', a, a.replace('item<', 'stuk<'))).toEqual(['text']);
    expect(kinds('src/app/list.component.html', a, a.replace('t of items', 't of all'))).toEqual(['code']);
    const b = '<div>@if (isAdmin) {<p>Hoi</p>}</div>';
    expect(kinds('src/app/x.component.html', b, b.replace('isAdmin', 'true'))).toEqual(['code']);
  });
  it('script/iframe urls and javascript: links are code', () => {
    const s = '<script src="/a.js"></script><iframe src="/x"></iframe><a href="/ok">Link</a>';
    expect(kinds('index.html', s, s.replace('/a.js', '/b.js'))).toEqual(['code']);
    expect(kinds('index.html', s, s.replace('src="/x"', 'src="/y"'))).toEqual(['code']);
    expect(kinds('index.html', s, s.replace('/ok', '/contact'))).toEqual(['text']);
    expect(kinds('index.html', s, s.replace('/ok', 'javascript:alert(1)'))).toEqual(['code']);
  });
  it('inline script bodies and v-html are code', () => {
    const s = '<p>Hoi</p><script>const a = 1</script>';
    expect(kinds('index.html', s, s.replace('a = 1', 'a = 2'))).toEqual(['code']);
    const v = '<div v-html="body"></div>';
    expect(kinds('pages/x.vue', v, v.replace('body', 'evil'))).toEqual(['code']);
  });
  it('style-config: module paths and locations stay code', () => {
    const t = "import c from 'tailwindcss/colors'\nexport default { content: ['./components/**/*.vue'], theme: { colors: { brand: '#123' } } }";
    expect(kinds('tailwind.config.ts', t, t.replace('#123', '#456'))).toEqual(['style']);
    expect(kinds('tailwind.config.ts', t, t.replace('tailwindcss/colors', 'evil'))).toEqual(['code']);
    expect(kinds('tailwind.config.ts', t, t.replace('./components', './x'))).toEqual(['code']);
  });
  it('unsafe svg is code, dot-paths and server dirs are code', () => {
    expect(kinds('public/logo.svg', '<svg/>', '<svg onload="x()"/>')).toEqual(['code']);
    expect(kinds('public/logo.svg', '<svg/>', '<svg><path/></svg>')).toEqual(['asset']);
    expect(kinds('app/api/route.ts', "const title = 'a'", "const title = 'b'")).toEqual(['code']);
    expect(kinds('.github/workflows/x.yml', 'a', 'b')).toEqual(['code']);
  });
  it('comments and formatting alone are no change', () => {
    const a = "const x = compute(a, b)";
    expect(kinds('utils/x.ts', a, "// note\nconst x = compute(\n  a,\n  b,\n)".replace(',\n)', '\n)'))).toEqual([]);
  });
});

describe('classifyChange — obfuscated script urls', () => {
  it('entity-encoded, whitespace-split and escaped javascript: urls are code', () => {
    const a = '<a href="/ok">Link</a>';
    for (const bad of ['&#106;avascript:alert(1)', 'java\tscript:alert(1)', ' JAVASCRIPT:alert(1)', 'javascript&colon;alert(1)', 'data:text/html,<script>', 'java&#x0A;script:x']) {
      expect(kinds('pages/a.vue', a, a.replace('/ok', bad))).toEqual(['code']);
    }
    expect(kinds('pages/a.vue', a, a.replace('/ok', 'https://example.com/a?b=c&d=e'))).toEqual(['text']);
    expect(kinds('pages/a.vue', a, a.replace('/ok', 'mailto:info@example.com'))).toEqual(['text']);
    const s = "const links = [{ label: 'A', href: '/a' }]";
    expect(kinds('components/N.vue', `<script setup>${s}</script>`, `<script setup>${s.replace("'/a'", "'\\x6aavascript:x'")}</script>`)).toEqual(['code']);
  });
});

describe('classifyChange — review findings', () => {
  const js = (body: string) => `<script setup>\n${body}\n</script>`;
  it('assignments to text-like names are code (redirect, script src, CSP)', () => {
    expect(kinds('pages/a.vue', js('location.href = "/thanks"'), js('location.href = "https://evil.example.com"'))).toEqual(['code']);
    expect(kinds('utils/x.ts', 'el.src = "/app.js"', 'el.src = "https://evil.example.com/x.js"')).toEqual(['code']);
    expect(kinds('utils/x.ts', 'const title = "A"', 'const title = "B"')).toEqual(['code']);
    const csp = (v: string) => js(`useHead({ meta: [{ httpEquiv: 'Content-Security-Policy', content: "${v}" }] })`);
    expect(kinds('app.vue', csp("default-src 'self'"), csp("default-src *"))).toEqual(['code']);
  });
  it('object-literal copy keys stay text; ternaries and case labels do not count', () => {
    expect(kinds('pages/a.vue', js("const hero = { title: 'A', subtitle: 'B' }"), js("const hero = { title: 'X', subtitle: 'Y' }"))).toEqual(['text']);
    expect(kinds('utils/x.ts', "const r = ok ? title : 'a'", "const r = ok ? title : 'b'")).toEqual(['code']);
    expect(kinds('utils/x.ts', "const r = { a: ok ? 'x' : 'y' }", "const r = { a: ok ? 'x' : 'z' }")).toEqual(['code']);
  });
  it('server dirs are code regardless of case', () => {
    expect(kinds('Server/api/x.ts', "const x = { label: 'a' }", "const x = { label: 'b' }")).toEqual(['code']);
    expect(kinds('src/Api/x.ts', "const x = { label: 'a' }", "const x = { label: 'b' }")).toEqual(['code']);
  });
});
