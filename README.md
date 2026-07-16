# Claudable

<img src="https://storage.googleapis.com/claudable-assets/Claudable.png" alt="Claudable" style="width: 100%;" />
<div align="center">
<h3>Connect CLI Agent • Build what you want • Deploy instantly</h3>
</div>
<p align="center">
<a href="https://github.com/hesreallyhim/awesome-claude-code">
<img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code">
</a>
<a href="https://twitter.com/aaron_xong">
<img src="https://img.shields.io/badge/Follow-@aaron__xong-000000?style=flat&logo=x&logoColor=white" alt="Follow Aaron">
</a>
<a href="https://discord.gg/NJNbafHNQC">
<img src="https://img.shields.io/badge/Discord-Join%20Community-7289da?style=flat&logo=discord&logoColor=white" alt="Join Discord Community">
</a>
<a href="https://github.com/opactorai/Claudable">
<img src="https://img.shields.io/github/stars/opactorai/Claudable?style=flat&logo=github&logoColor=white&labelColor=181717&color=f9d71c" alt="GitHub Stars">
</a>
<a href="https://github.com/opactorai/Claudable">
<img src="https://img.shields.io/github/forks/opactorai/Claudable?style=flat&logo=github&logoColor=white&labelColor=181717&color=181717" alt="GitHub Forks">
</a>
<a href="https://github.com/opactorai/Claudable/blob/main/LICENSE">
<img src="https://img.shields.io/github/license/opactorai/Claudable?style=flat&logo=github&logoColor=white&labelColor=181717&color=181717" alt="License">
</a>
</p>

---

## 🍴 About this fork

This is a **self-hosted fork** of [opactorai/Claudable](https://github.com/opactorai/Claudable),
adapted to run entirely on **your own infrastructure** (no Vercel / GitHub / Supabase
required) and extended into a **multi-user, team review** tool. Everything upstream still
works; this fork adds:

- **Self-hosting on your own box** — provider-aware Git (self-hosted **Gitea** as well as
  GitHub), one-click publish + auto-deploy via **Gitea Actions**, and a shared **Traefik**
  proxy. Each running preview gets a **stable per-project subdomain** with automatic HTTPS
  (Let's Encrypt DNS-01), isolated so one project's preview can never show another's.
- **Multiple stacks + project composition** — start from **Nuxt**, **Next.js**, **Angular**,
  a **print-ready Document** (HTML→PDF), or the **Filament (Laravel) CMS** stack, and
  optionally compose a backend + database at creation time.
- **Filament (Laravel) CMS stack** — new Filament projects are scaffolded from the NewStory
  golden template (cloned from a private repo + re-slugged), run in a PHP preview, and
  publish with one click as **php-fpm + nginx + Postgres** (schema auto-migrated on deploy).
- **Managed service containers** — attach a per-project **Postgres / MySQL / Redis / Mongo**
  container in one click (its `DATABASE_URL`/connection env is injected into preview *and*
  deploy), or provision a Coolify-managed Postgres.
- **Plugins** — Claude Code **plugin marketplaces** available to every project, invoked with
  `/plugin`; you can even start a new project straight from a plugin command.
- **MCP servers** — a per-project and shared **MCP catalog** with OAuth-authenticated servers,
  managed from settings and invoked with `/mcp`.
- **Checkpoints & revert** — every agent turn is checkpointed; restore the project to any
  step in one click. The agent also detects build/runtime errors and offers a fix.
- **Multi-user** — Google login with an auth gate, per-project access control, and
  per-user Claude credentials (paste your own `claude setup-token`). Chat is
  **collaborative in real time**: everyone viewing a project sees messages and the agent's
  streaming output appear live (one agent turn at a time per project).
- **Internationalization** — the whole interface is translatable, shipping with **8
  languages** (English, Dutch, German, French, Spanish, Italian, Portuguese, Japanese).
  Pick the display language in Settings → General; it saves **per user** and follows your
  account across devices.
- **Design Explorer** — a Claude-Design-style canvas. Describe a page and get several
  standalone design mockups generated **side-by-side**, each seeded with a different style
  from the catalog. Compare them live, **refine**/**regenerate** any one (kept as versions),
  **combine** two into a hybrid, or seed from a **reference image** — then **Use this** to
  port the chosen design into your real project (checkpointed, so it's revertible). Mockups
  are generated in isolated, tool-restricted sandboxes and rendered in locked-down iframes.
- **Visual editor** — an *Edit* mode to click elements in the live preview and tweak text
  & CSS, then apply the change to code through the agent.
- **Preview comments** — Figma-style pinned, per-route review comments overlaid on the
  preview (Claudable-only; never touches the app source), with author, @-mentions,
  resolve & clear-all.
- **Device preview** — a device selector (iPhone/iPad/Pixel/Surface…) with portrait ⇄
  landscape and always-fit scaling.
- **it-ops broker** *(admin-opt-in, per user)* — scoped, audited infrastructure tools the
  agent can use (Gitea repo/admin, Coolify apps & projects, Traefik routes); AWS/IAM stays
  propose-only, and credentials never enter the agent's context.
- **Agent & preview sandboxing** — previews and each per-turn agent run in **hardened
  containers** (non-root, `cap-drop ALL`, no-new-privileges, resource limits) on an
  **egress-locked network** (public internet allowed; the box's private network, other
  projects, and Claudable's own data blocked). The agent's environment is scrubbed of
  Claudable's secrets.
- **Quality-of-life** — a large **design-style catalog** (skills), chunked large-file
  uploads with progress, a project **dashboard** with live thumbnails, and a richer chat:
  markdown/JSON-aware rendering, message timestamps, and auto-loading history that keeps
  your scroll position anchored.

Deployment specifics live in `.env.example` and `docker-compose.yml`; no infrastructure
values or secrets are committed. It tracks upstream and is not intended for merge back.

---

## What is Claudable?

Claudable is a powerful Next.js-based web app builder that combines **C**laude Code's (Cursor CLI also supported!) advanced AI agent capabilities with **Lovable**'s simple and intuitive app building experience. Just describe your app idea - "I want a task management app with dark mode" - and watch as Claudable instantly generates the code and shows you a live preview of your working app. You can deploy your app to Vercel and integrate database with Supabase for free.

This open-source project empowers you to build and deploy professional web applications easily for **free**.

How to start? Simply login to Claude Code (or Cursor CLI), start Claudable, and describe what you want to build. That's it. There is no additional subscription cost for app builder.

## Features

- **Powerful Agent Performance**: Leverage the full power of Claude Code and Cursor CLI Agent capabilities
- **Natural Language to Code**: Simply describe what you want to build, and Claudable generates production-ready Next.js code
- **Instant Preview**: See your changes immediately with hot-reload as AI builds your app
- **Zero Setup, Instant Launch**: No complex sandboxes, no API key, no database headaches - just start building immediately
- **Beautiful UI**: Generate beautiful UI with Tailwind CSS and shadcn/ui
- **Deploy to Vercel**: Push your app live with a single click, no configuration needed
- **GitHub Integration**: Automatic version control and continuous deployment setup
- **Supabase Database**: Connect production PostgreSQL with authentication ready to use
- **Desktop App**: Available as Electron desktop application for Mac, Windows, and Linux

## Supported AI Coding Agents

Claudable supports multiple AI coding agents, giving you the flexibility to choose the best tool for your needs:

- **Claude Code** - Anthropic's advanced AI coding agent
- **Codex CLI** - OpenAI's powerful coding agent
- **Cursor CLI** - Powerful multi-model AI agent
- **Qwen Code** - Alibaba's open-source coding CLI
- **Z.AI GLM-4.6** - Zhipu AI's coding agent

### Claude Code (Recommended)
**[Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup)** - Anthropic's advanced AI coding agent with Claude Opus 4.6
- **Features**: Deep codebase awareness, Unix philosophy, direct terminal integration
- **Context**: Native 200k tokens
- **Pricing**: Included with Claude Pro/Max/Team/Enterprise plans, or Anthropic API key
- **Installation**:
  ```bash
  npm install -g @anthropic-ai/claude-code
  claude  # then > /login
  ```

### Codex CLI
**[Codex CLI](https://github.com/openai/codex)** - OpenAI's powerful coding agent with GPT-5 support
- **Features**: High reasoning capabilities, local execution, multiple operating modes (interactive, auto-edit, full-auto)
- **Context**: Varies by model
- **Pricing**: Included with ChatGPT Plus/Pro/Business/Edu/Enterprise plans (from $20/month)
- **Installation**:
  ```bash
  npm install -g @openai/codex
  codex  # login with ChatGPT account
  ```

### Cursor CLI
**[Cursor CLI](https://cursor.com/en/cli)** - Powerful AI agent with access to cutting-edge models
- **Features**: Multi-model support (Anthropic, OpenAI), AGENTS.md support
- **Context**: Model dependent
- **Pricing**: Free tier available, Pro from $20/month (credit-based system)
- **Installation**:
  ```bash
  curl https://cursor.com/install -fsS | bash
  cursor-agent login
  ```

### Qwen Code
**[Qwen Code](https://github.com/QwenLM/qwen-code)** - Alibaba's open-source CLI for Qwen3-Coder models
- **Features**: 256K-1M token context, multiple model sizes (0.5B to 480B), Apache 2.0 license
- **Context**: 256K native, 1M with extrapolation
- **Pricing**: Completely free and open-source
- **Installation**:
  ```bash
  npm install -g @qwen-code/qwen-code@latest
  qwen --version
  ```

### Z.AI GLM-4.6
**[Z.AI GLM-4.6](https://z.ai/subscribe)** - Zhipu AI's coding agent powered by GLM-4.6
- **Features**: Strong reasoning capabilities and cost-efficient, code generation and understanding
- **Context**: 200K tokens
- **Pricing**: Starting from $3/month (GLM Coding Lite) to $30/month (GLM Coding Max), with 50% off first month
- **Installation**: See [Quick Start Guide](https://docs.z.ai/devpack/quick-start)

## Technology Stack

**Database & Deployment:**
- **[Supabase](https://supabase.com/)**: Connect production-ready PostgreSQL database directly to your project.
- **[Vercel](https://vercel.com/)**: Publish your work immediately with one-click deployment

**There is no additional subscription cost and built just for YOU.**

## Prerequisites

Before you begin, ensure you have the following installed:
- Node.js 18+
- Claude Code or Cursor CLI (already logged in)
- Git

## Quick Start

Get Claudable running on your local machine in minutes:

```bash
# Clone the repository
git clone https://github.com/opactorai/Claudable.git
cd Claudable

# Install all dependencies
npm install

# Start development server
npm run dev
```

Your application will be available at http://localhost:3000

**Note**: Ports are automatically detected. If the default port is in use, the next available port will be assigned.

## Troubleshooting
- **Database migration conflicts**: If you upgraded from a previous Claudable version and run into database errors, reset the Prisma database so it matches the latest schema:
  ```bash
  npm run prisma:reset
  ```
  The command drops and recreates the local database, so back up any data you need before running it.

## Setup

The `npm install` command automatically handles the complete setup:

1. **Port Configuration**: Detects available ports and creates `.env` files
2. **Dependencies**: Installs all required Node.js packages
3. **Database Setup**: SQLite database auto-creates at `data/cc.db` on first run

### Desktop App (Electron)

Build and run Claudable as a desktop application:

```bash
# Development mode
npm run dev:desktop

# Build desktop app
npm run build:desktop

# Package for specific platforms
npm run package:mac      # macOS
npm run package:win      # Windows
npm run package:linux    # Linux
```

### Additional Commands
```bash
npm run db:backup   # Create a backup of your SQLite database
                    # Use when: Before major changes or deployments
                    # Creates: data/backups/cc_backup_[timestamp].db

npm run db:reset    # Reset database to initial state
                    # Use when: Need fresh start or corrupted data
                    # Warning: This will delete all your data!

npm run clean       # Remove all dependencies
                    # Use when: Dependencies conflict or need fresh install
                    # Removes: node_modules/, package-lock.json
                    # After running: npm install to reinstall everything
```

## Usage

### Getting Started with Development

1. **Connect Claude Code**: Link your Claude Code CLI to enable AI assistance
2. **Describe Your Project**: Use natural language to describe what you want to build
3. **AI Generation**: Watch as the AI generates your project structure and code
4. **Live Preview**: See changes instantly with hot reload functionality
5. **Deploy**: Push to production with Vercel integration

### Database Operations

Claudable uses SQLite for local development. The database automatically initializes on first run.

## Troubleshooting

### Port Already in Use

The application automatically finds available ports. Check the `.env` file to see which ports were assigned.

### Installation Failures

```bash
# Clean all dependencies and retry
npm run clean
npm install
```

### Claude Code Permission Issues (Windows/WSL)

If you encounter the error: `Error output dangerously skip permissions cannot be used which is root sudo privileges for security reasons`

**Solution:**
1. Do not run Claude Code with `sudo` or as root user
2. Ensure proper file ownership in WSL:
   ```bash
   # Check current user
   whoami
   
   # Change ownership of project directory to current user
   sudo chown -R $(whoami):$(whoami) ~/Claudable
   ```
3. If using WSL, make sure you're running Claude Code from your user account, not root
4. Verify Claude Code installation permissions:
   ```bash
   # Reinstall Claude Code without sudo
   npm install -g @anthropic-ai/claude-code --unsafe-perm=false
   ```

## Integration Guide

### GitHub
**Get Token:** [GitHub Personal Access Tokens](https://github.com/settings/tokens) → Generate new token (classic) → Select `repo` scope

**Connect:** Settings → Service Integrations → GitHub → Enter token → Create or connect repository

### Vercel  
**Get Token:** [Vercel Account Settings](https://vercel.com/account/tokens) → Create Token

**Connect:** Settings → Service Integrations → Vercel → Enter token → Create new project for deployment

### Supabase
**Get Credentials:** [Supabase Dashboard](https://supabase.com/dashboard) → Your Project → Settings → API
- Project URL: `https://xxxxx.supabase.co`  
- Anon Key: Public key for client-side
- Service Role Key: Secret key for server-side


## License

MIT License.

## Upcoming Features
These features are in development and will be opened soon.
- **Native MCP Support** - Model Context Protocol integration for enhanced agent capabilities
- **Checkpoints for Chat** - Save and restore conversation/codebase states
- **Enhanced Agent System** - Subagents, AGENTS.md integration
- **Website Cloning** - You can start a project from a reference URL.
- Various bug fixes and community PR merges

We're working hard to deliver the features you've been asking for. Stay tuned!

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=opactorai/Claudable&type=Date)](https://www.star-history.com/#opactorai/Claudable&Date)
