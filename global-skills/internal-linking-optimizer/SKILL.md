---
name: internal-linking-optimizer
description: 'Use when the user asks to "fix internal linking" or "find orphan pages"; maps link architecture, authority flow, anchor text, and crawl depth, then delivers a prioritized source/target/anchor plan. Not for external backlinks — use backlink-analyzer. 内链优化/站内架构'
version: "9.9.10"
license: Apache-2.0
compatibility: "Claude Code and compatible agent-skill hosts"
homepage: "https://github.com/aaron-he-zhu/seo-geo-claude-skills"
when_to_use: "Use when improving internal link structure, anchor text distribution, orphan pages, or site architecture."
argument-hint: "<URL or sitemap>"
metadata:
  author: aaron-he-zhu
  version: "9.9.10"
  geo-relevance: "low"
  tags:
    - seo
    - internal-linking
    - site-architecture
    - link-equity
    - orphan-pages
    - topical-authority
    - crawl-depth
    - 内链优化
    - 内部リンク
    - 내부링크
    - enlaces-internos
  triggers:
    - "improve site architecture"
    - "internal linking strategy"
    - "link equity flow"
    - "pages have no links"
    - "site architecture is messy"
    - "suggest internal links for this article"
    - "fix anchor text distribution"
    - "内链优化"
    - "孤立页面"
---

# Internal Linking Optimizer

Analyzes internal link structure, authority flow, orphan pages, anchor text, and topic clusters, then delivers a prioritized linking plan with source/target/anchor recommendations.

## Quick Start

Start with one of these prompts, then finish with the standard handoff summary from [Skill Contract](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/references/skill-contract.md).

```text
Analyze internal linking structure for [domain/sitemap]
Find internal linking opportunities for [URL]
Create internal linking plan for topic cluster about [topic]
Suggest internal links for this new article: [content/URL]
Find orphan pages on [domain]
Optimize anchor text across the site
```

## Skill Contract

**Expected output**: a scored diagnosis, prioritized repair plan, and a short handoff summary ready for `memory/audits/`.

- **Reads**: sitemap or page list, key page URLs, content categories, and article/URL to link from.
- **Writes**: a user-facing linking plan plus a reusable summary that can be stored under `memory/audits/`.
- **Promotes**: blocking defects, repeated weaknesses, fix priorities, and pending decisions to `memory/open-loops.md`.
- **Done when**: orphan pages are listed with a disposition; anchor distribution is checked against thresholds; a prioritized source/target/anchor plan and handoff summary are produced.
- **Primary next skill**: use the `Next Best Skill` below when the repair path is clear.

### Handoff Summary

> Emit the standard shape from [skill-contract.md §Handoff Summary Format](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/references/skill-contract.md).

## Data Sources

Uses ~~web crawler and ~~analytics when connected; otherwise asks user for sitemap, key page URLs, and content categories. See [CONNECTORS.md](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/CONNECTORS.md) and [SECURITY.md §Scraping Boundaries](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/SECURITY.md).

**Zero-dependency local helper** (no tool needed): `python3 scripts/connectors/crawl.py <url> | python3 scripts/connectors/linkgraph.py -` computes orphans, click-depth, and internal PageRank from a live crawl. See [scripts/connectors/README.md](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/scripts/connectors/README.md).

## Instructions

Label every metric **Measured** (tool/export), **User-provided**, or **Estimated** (model inference); never present an estimate as measured; if a required metric is unavailable, mark it N/A — do not invent it.

When a user requests internal linking optimization:

1. **Analyze Current Structure** — Capture domain, pages analyzed, total internal links, average links/page, link distribution, top linked pages, under-linked important pages, and a **structure score /100** (start at 100; −10 per orphan page, −5 per important page deeper than 3 clicks, −5 per page with 0 inbound contextual links, −10 if avg links/page is outside the architecture model's target range in [Link Architecture Patterns](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/link-architecture-patterns.md); floor 0). Flag crawl-depth and authority-flow problems.
2. **Identify Orphan Pages** — List pages with no inbound internal links. Prioritize high-value orphans with traffic/rankings, medium-potential pages that need category/tag links, and low-value pages to delete, noindex, or redirect.
3. **Analyze Anchor Text Distribution** — Check current anchor patterns, distribution by page, over-optimization, generic anchors, and CORE-EEAT R08 alignment. Anchor Score /10 and thresholds are defined in the Step 3 template.
   > **Reference**: [references/linking-templates.md](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/linking-templates.md) contains the Step 3 output template.
4. **Create Topic Cluster Link Strategy** — Map pillar/cluster links, recommend structure, and list specific links to add.
   > **Reference**: [references/linking-templates.md](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/linking-templates.md) contains the Step 4 template.
5. **Find Contextual Link Opportunities** — For each page, identify topic-relevant source/target/anchor opportunities and prioritize high-impact additions.
   > **Reference**: [references/linking-templates.md](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/linking-templates.md) contains the Step 5 template.
6. **Optimize Navigation and Footer Links** — Review main/footer/sidebar/breadcrumb navigation; recommend pages to add, demote, or remove.
   > **Reference**: [references/linking-templates.md](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/linking-templates.md) contains the Step 6 template.
7. **Generate Implementation Plan** — Include executive summary, current-state metrics, phased priority actions, implementation guide, and tracking plan.
   > **Reference**: [references/linking-templates.md](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/linking-templates.md) contains the Step 7 template.

## Decision Gates

**Stop and ask the user when:**
- A high-value orphan must be deleted, noindexed, or redirected and its traffic/ranking value is unknown — state what you see and ask: (1) keep and add links, (2) noindex, (3) 301-redirect to the nearest relevant page.

**Continue silently (never stop for):**
- Which architecture model to apply — infer it from site type and page count using [Link Architecture Patterns](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/link-architecture-patterns.md), state the choice, and proceed.
- No crawler/analytics data — work from the provided sitemap or page list, label inferred metrics Estimated, and proceed.
- A low-value orphan with no traffic — recommend the default disposition (noindex or redirect) without stopping.

## Example

**User**: "Find internal linking opportunities for my blog post on 'email marketing best practices'"

**Output**: 5 high-value links with source paragraph, destination URL, recommended anchor text, and priority. Example targets might include list-building, subject-line, segmentation, automation, and tools pages.

> **Reference**: See [references/linking-example.md](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/linking-example.md) for the full worked example.

## Tips for Success

- Prioritize relevance and user navigation over link volume.
- Use descriptive, varied anchors; avoid exact-match repetition.
- Link important pages from hubs, navigation, or strong contextual sources.
- Audit regularly as content grows.

### Save Results

Ask to save results; if yes, write a dated summary to `memory/audits/internal-linking-optimizer/YYYY-MM-DD-<topic>.md`. Hand off veto-level risks to the auditor gate before any hot-cache marker.

## Reference Materials

- [Link Architecture Patterns](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/link-architecture-patterns.md) — Architecture models, selection thresholds, migration safeguards, and measurement targets
- [Linking Templates](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/linking-templates.md) — Detailed output templates for steps 3-7
- [Linking Example](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/internal-linking-optimizer/references/linking-example.md) — Full worked example for internal linking opportunities

## Next Best Skill

Primary: [on-page-seo-auditor](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/optimize/on-page-seo-auditor/SKILL.md) — verify that revised internal links support page-level goals.
