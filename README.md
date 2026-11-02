# Trail

A cross-machine coding agent that **proves its work**: every claim it makes when finishing a task must cite evidence the harness recorded (commands with exit codes, file writes), and every step is inspectable.

> Status: milestones M1 (core, CLI) and M2 (SSH workspaces, multi-machine sessions, context compaction, subagents). See [docs/设计文档.md](docs/设计文档.md) for the design and roadmap.

## Requirements

- Node.js 24+
- Windows: Git Bash is used for commands when installed, otherwise PowerShell

## Run

```bash
npm install
npm run trail -- --help
```

Pick a model in one of three ways:

```bash
# Claude
export ANTHROPIC_API_KEY=...

# Any OpenAI-compatible endpoint (DeepSeek, Qwen, Kimi, GLM, Ollama, OpenRouter, ...)
export TRAIL_BASE_URL=https://api.deepseek.com
export TRAIL_MODEL=<model id from the provider's docs>
export TRAIL_API_KEY=...
```

or write `~/.trail/config.json` (see [docs/config.example.json](docs/config.example.json)); `"apiKey": "env:NAME"` reads the key from an environment variable.

```bash
npm run trail -- "fix the failing test in src/"     # one task
npm run trail                                       # interactive session
npm run trail -- sessions                           # history
npm run trail -- inspect <session>                  # timeline, tokens, cache, cost
npm run trail -- inspect <session> --request 3      # exact body sent to the model
npm run trail -- report <session>                   # completion claims and their evidence
```

## Working across machines

Save a server once. The password is typed (never passed as an argument) and stored in the system keychain; the host key fingerprint is shown for you to confirm and is checked on every connection.

```bash
npm run trail -- ws add-ssh staging deploy@10.0.0.5 /srv/shop      # asks for the password, shows the host key
npm run trail -- ws add-ssh prod deploy@10.0.0.9 /srv/shop --key ~/.ssh/id_ed25519
npm run trail -- ws                                                 # list
npm run trail -- ws test staging
```

Attach them to a task with `-W alias=name[:level]`. Levels are `full`, `ask-write`, `read-only` and `ask-all`; names or descriptions that look like production (`prod`, `生产`, `线上`) default to `read-only`.

```bash
npm run trail -- -W staging=staging:full -W prod=prod "deploy the port change to staging, then compare its config with prod"
```

The current directory is attached as `local` (use `--no-local` to leave it out, and `--primary staging` to make another workspace the default). Every tool takes an optional `workspace`, `transfer` copies files between machines, and evidence records which machine it came from, so a test run on staging can never prove a claim about prod.

## How proof works

Every tool result ends with an evidence line, e.g. `[evidence: ev_3 | local | exit 0 | 0.4s]`. To finish, the model calls `complete` with claims such as `{ "kind": "tests_passed", "evidence": ["ev_3"] }`. The harness rejects a claim when the evidence does not exist, the command failed, the tests ran before the last file change, or the evidence comes from another workspace. After three rejections the task ends as "without acceptable proof".

## Development

```bash
npm test            # node:test, all packages
npm run typecheck   # tsc, no emit
```

TypeScript runs directly on Node (type stripping), so source files use only erasable syntax.

| Package | Role |
|---|---|
| `protocol` | Shared types: messages, evidence, claims, events |
| `llm` | Model adapters: OpenAI-compatible, Anthropic, scripted test provider |
| `agent` | Stateless agent loop |
| `workspace` | `Operations` interface; local and SSH (ssh2) implementations |
| `tools` | read, write, edit, bash, grep, glob, read_output, transfer, complete, task |
| `evidence` | Claim validation rules and the completion report |
| `core` | Sessions, SQLite event log, permissions, compaction, subagents, saved workspaces and keychain |
| `inspector` | Usage totals and timeline from the event log |
| `cli` | The `trail` command |

## License

AGPL-3.0-only
