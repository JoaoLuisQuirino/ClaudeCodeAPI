# ClaudeCodeAPI

HTTP API over the official Claude Code binary. Use your Claude subscription (Pro/Max) as an API — no per-token costs.

Two products in one:
- **Provider** — drop-in replacement for Anthropic/OpenAI API (LLM mode)
- **Agent** — full Claude Code agent with tools, files, MCP, multi-turn sessions

## Quick Start

```bash
git clone https://github.com/uaibuilder/claudecodeapi.git
cd claudecodeapi
npm install
npm run build
npm start
# Server runs on http://localhost:3456
```

Verify: `curl http://localhost:3456/health`

## Requirements

- Node.js >= 20
- [Claude Code CLI](https://cli.claude.ai) installed (`npm install -g @anthropic-ai/claude-code`)
- A Claude Pro/Max subscription

## Authentication

Users authenticate with their Claude subscription OAuth token.

### Option A: Browser OAuth (recommended)

```bash
# 1. Start login flow
curl -X POST http://localhost:3456/auth/login
# Returns: { "login_id": "...", "auth_url": "https://claude.com/..." }

# 2. Open auth_url in browser, authorize

# 3. Poll for completion
curl http://localhost:3456/auth/status/{login_id}
# Returns: { "status": "completed", "access_token": "sk-ant-oat01-..." }
```

### Option B: Manual credentials

```bash
curl -X POST http://localhost:3456/auth/setup \
  -H "Content-Type: application/json" \
  -d @~/.claude/.credentials.json
```

Use the `accessToken` as Bearer token in all requests.

## API Endpoints

### Provider Mode (LLM)

Stateless, single-turn. Drop-in replacement for Anthropic/OpenAI APIs.

#### POST /v1/messages (Anthropic compatible)

```bash
curl http://localhost:3456/v1/messages \
  -H "Authorization: Bearer sk-ant-oat01-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

#### POST /v1/chat/completions (OpenAI compatible)

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer sk-ant-oat01-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

Works with Cursor, Continue, LangChain, Vercel AI SDK, or any OpenAI-compatible client.

### Agent Mode (Claude Code)

Full agentic loop with multi-turn sessions, tool use, file handling, MCP, and context compaction.

#### POST /chat

```bash
# First message — creates session
curl http://localhost:3456/chat \
  -H "Authorization: Bearer sk-ant-oat01-..." \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze the CSV files in my workspace",
    "model": "opus",
    "stream": true,
    "context_md": "# Context\nYou are a data analyst.",
    "mcp_config": {
      "mcpServers": {
        "myapp": { "type": "http", "url": "https://example.com/mcp" }
      }
    },
    "allow_network": true
  }'
# Returns session_id in the stream

# Continue conversation
curl http://localhost:3456/chat \
  -H "Authorization: Bearer sk-ant-oat01-..." \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Now filter only sales above $100",
    "session_id": "sess_abc123",
    "stream": true
  }'
```

#### POST /agent

```bash
curl http://localhost:3456/agent \
  -H "Authorization: Bearer sk-ant-oat01-..." \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Install puppeteer, scrape google.com, and save a screenshot",
    "model": "opus",
    "stream": true,
    "max_turns": 50,
    "max_timeout": 0
  }'
```

#### Chat/Agent request fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `message` / `task` | string | required | The prompt |
| `session_id` | string | auto-generated | Continue an existing session |
| `model` | string | `sonnet` | `sonnet`, `opus`, `haiku` |
| `stream` | boolean | `true` | SSE streaming or JSON response |
| `system_prompt` | string | - | System prompt |
| `context_md` | string | - | Written as CLAUDE.md (auto-read by Claude Code) |
| `mcp_config` | object | - | MCP server configuration |
| `max_turns` | number | `50` | Max agentic loop iterations |
| `max_timeout` | number | global | Per-request timeout in ms (`0` = no timeout) |
| `allow_network` | boolean | `false` | Allow network in Docker containers |

#### SSE event types (streaming)

```
event: system       — init metadata (tools, mcp_servers, model)
event: assistant    — text response from Claude
event: tool_use     — Claude called a tool (name, input)
event: tool_result  — tool execution result
event: result       — final event (usage, cost, session_id)
event: session      — session_id for multi-turn continuation
```

### File Management

```bash
# Upload (optionally to a session)
curl -X POST http://localhost:3456/upload?session_id=sess_abc \
  -H "Authorization: Bearer sk-ant-oat01-..." \
  -F "file=@data.csv"

# List files
curl http://localhost:3456/files \
  -H "Authorization: Bearer sk-ant-oat01-..."

# Download
curl http://localhost:3456/files/data.csv \
  -H "Authorization: Bearer sk-ant-oat01-..."

# Delete
curl -X DELETE http://localhost:3456/files/data.csv \
  -H "Authorization: Bearer sk-ant-oat01-..."
```

ZIP files are auto-extracted. Per-user quota: 500MB (configurable).

### Other Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check (queue stats, memory, disk) |
| GET | /health/live | Liveness probe |
| GET | /health/ready | Readiness probe |
| GET | /sessions | List active sessions |
| DELETE | /sessions/:id | Delete a session |
| GET | /usage | Token usage and cost tracking |

## Configuration

All via environment variables:

```bash
PORT=3456                        # Server port
HOST=0.0.0.0                    # Bind address
DATA_DIR=./data                  # Data directory
DEFAULT_MODEL=sonnet             # Default model

# Concurrency
MAX_CONCURRENT=8                 # Max concurrent claude processes
MAX_CONCURRENT_PER_USER=3        # Per-user concurrency limit
MAX_QUEUE_SIZE=50                # Request queue size
QUEUE_TIMEOUT_MS=60000           # Max queue wait time
PROCESS_TIMEOUT_MS=300000        # Max process runtime (0 = no timeout)

# Files
MAX_FILE_SIZE=104857600          # Max upload size (100MB)
MAX_USER_DISK_BYTES=524288000    # Per-user disk quota (500MB)
FILE_CLEANUP_HOURS=24            # Auto-delete files older than this

# Security
CORS_ORIGINS=*                   # Allowed origins (comma-separated)
TRUST_PROXY=false                # Trust X-Forwarded-For headers
ALLOWED_MODELS=sonnet,opus,haiku # Whitelist of allowed models

# Scaling
CLUSTER_ENABLED=false            # Multi-core clustering
CLUSTER_WORKERS=0                # Worker count (0 = auto)

# Docker isolation (multi-user)
DOCKER_ISOLATION=false           # Isolate each request in a container
DOCKER_IMAGE=claudecodeapi/sandbox
DOCKER_MEMORY=512m
DOCKER_CPUS=1

# Misc
CLAUDE_BINARY=claude             # Path to claude binary
LOG_LEVEL=info                   # debug, info, warn, error
```

## Multi-User Isolation

For multi-tenant deployments with untrusted users:

```bash
docker build -t claudecodeapi/sandbox -f docker/Dockerfile.sandbox .
DOCKER_ISOLATION=true npm start
```

Each request runs in an isolated container with:
- **No network** (`--network=none`) — configurable per-request with `allow_network`
- **Read-only filesystem**
- **Memory/CPU limits**
- **Volume isolation** — User A cannot see User B's files

## Session Management

Sessions use `--resume` to maintain conversation context across requests:

```
Msg 1: POST /chat { message: "hi" }
  → Claude creates session, returns session_id
  → Context: 1 turn

Msg 2: POST /chat { message: "remember?", session_id: "sess_abc" }
  → --resume loads full history
  → Context: 2 turns (accumulated)

Msg N: keeps growing, Claude Code handles compaction automatically
```

Per-session locking prevents concurrent access (would corrupt session data).
Cancellation (client disconnect) sends SIGTERM — session is resumable afterward.

## Integration with SDKs

### Vercel AI SDK
```typescript
const claude = createAnthropic({
  baseURL: 'http://localhost:3456',
  apiKey: 'sk-ant-oat01-...',
});
```

### OpenAI SDK
```typescript
const client = new OpenAI({
  baseURL: 'http://localhost:3456/v1',
  apiKey: 'sk-ant-oat01-...',
});
```

### LangChain
```typescript
const model = new ChatOpenAI({
  configuration: { baseURL: 'http://localhost:3456/v1' },
  openAIApiKey: 'sk-ant-oat01-...',
  modelName: 'sonnet',
});
```

### Custom app (Agent mode)
```typescript
const res = await fetch('http://localhost:3456/chat', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer sk-ant-oat01-...',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    message: 'Install puppeteer and take a screenshot of google.com',
    max_timeout: 0,
    allow_network: true,
  }),
});

// Parse SSE stream for tool_use, assistant, result events
```

## Architecture

```
Client → HTTP request
  → Auth (Bearer token → user hash → isolated HOME)
  → Rate limit (per-IP)
  → Request Queue (global + per-user + per-session lock)
  → Spawn: claude -p "prompt" --output-format stream-json --resume <id>
  → Stream Parser (NDJSON → typed events)
  → SSE stream with keepalive pings (or JSON response)
  → Usage tracking (SQLite)
```

## Development

```bash
npm run dev        # Dev server with hot reload
npm test           # Run all tests (150)
npm run typecheck  # TypeScript strict check
npm run build      # Compile to dist/
```

## License

[Business Source License 1.1](LICENSE) — source available, free for non-competing use. Commercial hosted services require a paid license. Converts to MIT on 2030-04-05.
