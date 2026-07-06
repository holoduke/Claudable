/**
 * Starter scaffold for the "Document (PDF/HTML)" stack: a single self-contained
 * HTML file styled for A4 — propositions, one-pagers, quotes, reports. No build
 * step, no npm; the static preview server serves it directly and the Export PDF
 * button prints it via headless Chromium.
 */
import fs from 'fs/promises';
import path from 'path';

const DOCUMENT_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proposition</title>
<style>
  /* ---- Page setup: A4 with comfortable margins (used by PDF export/print) ---- */
  @page { size: A4; margin: 22mm 20mm; }

  :root {
    --ink: #1a1d21;
    --muted: #5c6470;
    --accent: #1f5eff;
    --rule: #e3e6ea;
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--ink);
    line-height: 1.55;
    background: #f2f3f5;
  }

  /* Each .page is one sheet. Add more .page sections for more pages. */
  .page {
    background: #fff;
    max-width: 210mm;
    min-height: 297mm;
    margin: 24px auto;
    padding: 22mm 20mm;
    box-shadow: 0 2px 24px rgba(16, 24, 40, 0.08);
  }

  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 4px; letter-spacing: -0.02em; }
  h2 { font-size: 18px; margin: 32px 0 8px; letter-spacing: -0.01em; }
  p  { margin: 8px 0; }
  .subtitle { color: var(--muted); font-size: 15px; margin-bottom: 28px; }
  .kicker { color: var(--accent); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.12em; margin-bottom: 12px; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 24px 0; }

  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14px; }
  th { text-align: left; color: var(--muted); font-weight: 600; padding: 8px 10px; border-bottom: 2px solid var(--ink); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--rule); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; }

  /* ---- Print / PDF: drop the screen chrome ---- */
  @media print {
    body { background: #fff; }
    .page { box-shadow: none; margin: 0; max-width: none; min-height: auto; padding: 0; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
  <main class="page">
    <div class="kicker">Proposition</div>
    <h1>Project title</h1>
    <p class="subtitle">Prepared for Client Name · Month YYYY — replace this starter with your content, or just tell the agent what the document should say.</p>

    <h2>Summary</h2>
    <p>One short paragraph stating what is being proposed and why it matters to the client.</p>

    <h2>Scope</h2>
    <p>What is included. Keep it concrete — deliverables, not activities.</p>

    <h2>Investment</h2>
    <table>
      <thead><tr><th>Item</th><th class="num">Amount</th></tr></thead>
      <tbody>
        <tr><td>Example line item</td><td class="num">€ 0,00</td></tr>
        <tr><td><strong>Total (excl. VAT)</strong></td><td class="num"><strong>€ 0,00</strong></td></tr>
      </tbody>
    </table>

    <footer>
      <span>New Story</span>
      <span>Page 1</span>
    </footer>
  </main>
</body>
</html>
`;

/** Write the starter document. Never overwrites an existing index.html. */
export async function scaffoldDocumentApp(projectPath: string): Promise<void> {
  await fs.mkdir(projectPath, { recursive: true });
  const indexPath = path.join(projectPath, 'index.html');
  try {
    await fs.access(indexPath);
    return; // existing document — leave it alone
  } catch {
    await fs.writeFile(indexPath, DOCUMENT_INDEX_HTML, 'utf8');
  }
}
