# Ollama and iFlow Evaluation

# Source

- Ollama request: https://github.com/opactorai/Claudable/issues/52
- iFlow request: https://github.com/opactorai/Claudable/issues/63
- Ollama API docs: https://github.com/ollama/ollama/blob/main/docs/api.md
- iFlow CLI repo: https://github.com/iflow-ai/iflow-cli

# Ollama

Ollama is useful, but it is not a drop-in Claudable agent.

Claudable needs an agent that can:

- inspect project files
- edit files
- run commands
- stream progress
- report tool activity

Ollama provides model serving and chat/generate APIs. Its API supports chat and streaming responses, but Claudable would need to implement the agent loop, tools, file editing, and command execution layer itself.

# Recommended Ollama Direction

Do not add Ollama as a direct CLI agent in the first pass.

Better options:

1. Support Ollama through OpenCode if OpenCode is configured with an Ollama provider.
2. Support Ollama through Droid or another agent that can use local models.
3. Add a future "local model provider" abstraction after agent-loop boundaries are designed.

# iFlow

iFlow is technically closer to a coding agent, but it is a poor new integration target.

The iFlow repo currently displays a shutdown notice for April 17, 2026 UTC+8. Since this project is being evaluated on April 11, 2026, that leaves only a few days of runway.

# Recommendation

- Do not implement iFlow support.
- Close or comment on #63 with the shutdown context.
- Prefer OpenCode or Droid for new CLI integrations.

