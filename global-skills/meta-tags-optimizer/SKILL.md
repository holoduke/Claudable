---
name: meta-tags-optimizer
description: 'Use when the user asks to "optimize meta tags"; improves titles, descriptions, Open Graph, Twitter cards, and CTR test variants. Not for JSON-LD structured data — use schema-markup-generator; not for body copy — use seo-content-writer. 标题优化/元描述/CTR'
version: "9.9.10"
license: Apache-2.0
compatibility: "Claude Code and compatible agent-skill hosts"
homepage: "https://github.com/aaron-he-zhu/seo-geo-claude-skills"
when_to_use: "Use when optimizing title tags, meta descriptions, Open Graph tags, or Twitter Cards for a page."
argument-hint: "<page URL or content>"
metadata:
  author: aaron-he-zhu
  version: "9.9.10"
  geo-relevance: "low"
  tags:
    - seo
    - meta-tags
    - title-tag
    - meta-description
    - open-graph
    - twitter-card
    - ctr-optimization
    - social-sharing
    - 标题优化
    - 元描述
    - メタタグ
    - 메타태그
    - meta-tags-seo
  triggers:
    - "my title tag needs work"
    - "low click-through rate"
    - "OG tags not showing"
    - "how to write a good title tag"
    - "Yoast SEO title tool"
    - "RankMath title optimizer"
    - "TDK优化"
    - "点击率太低"
---

# Meta Tags Optimizer

Creates title tags, meta descriptions, and social meta tags that improve CTR and sharing quality.

## Quick Start

```
Create meta tags for a page about [topic] targeting [keyword]
```

```
Improve these meta tags for better CTR: [current tags]
```

## Skill Contract

**Expected output**: a ready-to-use metadata package plus the standard handoff summary for `memory/content/`.

- **Reads**: the brief, target keywords, entity inputs, and quality constraints.
- **Writes**: a user-facing metadata deliverable and reusable summary.
- **Promotes**: approved angles, messaging choices, missing evidence, and publish blockers to `memory/hot-cache.md` and `memory/open-loops.md`; propose durable decisions as pending-decision items.
- **Done when**: three title and three description options are provided within the character limits with the keyword front-loaded; a complete OG/Twitter tag block is included; and C01 (Intent Alignment) and C02 (Direct Answer) pass.
- **Primary next skill**: [schema-markup-generator](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/build/schema-markup-generator/SKILL.md) when the metadata package is ready for structured-data support.

### Handoff Summary

> Emit the standard shape from [skill-contract.md §Handoff Summary Format](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/references/skill-contract.md).

## Data Sources

Optional search console and SEO tool integrations pull CTR data and competitor patterns automatically; otherwise ask for current tags, keywords, and competitors. See [CONNECTORS.md](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/CONNECTORS.md).

## Instructions

When a user requests meta-tag optimization, run these six steps:

1. **Gather Page Information** — URL, page type, primary and secondary keywords, audience, CTA, and value proposition.
2. **Create Optimized Title Tag** — keep it near 50-60 characters, front-load the keyword, and generate three options using the supported title formulas.
3. **Write Meta Description** — target 150-160 characters, include the keyword and CTA, and generate three options.
4. **Create Open Graph, Twitter Card, and Additional Meta Tags** — include OG, Twitter, canonical, robots, viewport, author, and article tags as needed.
5. **CORE-EEAT Alignment Check** — verify C01 (Intent Alignment) and C02 (Direct Answer).
6. **Provide CTR Optimization Tips** — explain the winning elements, tradeoffs, and A/B test options.

Label every metric **Measured** (tool/export), **User-provided**, or **Estimated** (model inference); never present an estimate as measured; if a required metric is unavailable, mark it N/A — do not invent it.

> **Reference**: See [Instructions Detail](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/build/meta-tags-optimizer/references/instructions-detail.md) for the compact workflow, formulas, alignment matrix, CTR analysis, and example. See [Meta Tag Code Templates](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/build/meta-tags-optimizer/references/meta-tag-code-templates.md) for HTML blocks.

## Example

Sample outcome: a 55-character title, a 150-160 character description, and a complete OG / Twitter / Article tag block. See the full worked sample in [Instructions Detail — Example](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/build/meta-tags-optimizer/references/instructions-detail.md#example).

## Tips for Success

Front-load keywords, match intent, be specific, test variations, and refresh tags when the SERP changes.

### Save Results

On user confirmation, save to `memory/content/YYYY-MM-DD-<topic>.md` — see [Skill Contract](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/references/skill-contract.md) §Save Results Template.

## Reference Materials

- [Instructions Detail](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/build/meta-tags-optimizer/references/instructions-detail.md) — Workflow, formulas, alignment matrix, example
- [Meta Tag Formulas](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/build/meta-tags-optimizer/references/meta-tag-formulas.md) — Title and description formulas
- [Meta Tag Code Templates](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/build/meta-tags-optimizer/references/meta-tag-code-templates.md) — HTML templates
- [CTR and Social Reference](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/build/meta-tags-optimizer/references/ctr-and-social-reference.md) — CTR patterns and social guidance

## Next Best Skill

- **Primary**: [schema-markup-generator](https://github.com/aaron-he-zhu/seo-geo-claude-skills/blob/main/build/schema-markup-generator/SKILL.md) — complete the SERP package with structured data.
