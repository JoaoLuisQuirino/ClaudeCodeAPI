# ClaudeCodeAPI

Dois produtos em um: **Provider** (LLM endpoint) e **Agent** (agent completo com tools). HTTP API sobre o binario oficial do Claude Code. Cada user traz a propria subscription.

## O problema

Claude Code é o melhor agent que existe — context compaction em 5 camadas, file handling nativo, MCP, retry sofisticado, token optimization automatico. Mas só funciona via terminal. Apps web, SaaS, e automacoes nao conseguem usar.

A API oficial da Anthropic (`api.anthropic.com`) cobra per-token e nao inclui as features do harness do Claude Code (compaction, file handling, etc). E o attestation criptografico do binario bloqueia OAuth tokens para modelos premium (Sonnet/Opus) fora do binario oficial.

## A solucao

Rodar o binario oficial `claude` em uma VPS, expor via HTTP API. O binario faz o attestation, a subscription funciona, Opus responde. A API wrapa isso em endpoints REST com streaming SSE.

## Arquitetura

```
Client (browser, SDK, SmoothAgent, qualquer app)
    |
    POST /chat { message, session_id, model, mcp_config }
    |
    v
ClaudeCodeAPI Server (Node.js, VPS)
    |
    spawna: claude -p "message" \
              --output-format stream-json \
              --model opus \
              --continue (session) \
              --mcp-config ./mcp.json \
              --permission-mode bypassPermissions
    |
    parseia stdout → SSE stream pro client
    |
    retorna: resposta + usage + cost + tokens + session_id
```

## Requisitos criticos

### 1. Multi-user simultaneo

Varios users precisam usar ao mesmo tempo, cada um com SUA subscription:

- Cada user autentica com o Claude Code no setup (uma vez)
- Cada user tem seu proprio diretorio de credentials (~/.claude-users/{userId}/)
- Requests de users diferentes spawnnam processos claude isolados
- Pool de processos para reutilizar sessions ativas (evita cold start)
- Limite de processos simultaneos por VPS (ex: 10-20 concurrent)

Estrategia de isolamento:
```
/home/claudecodeapi/
├── users/
│   ├── user_abc/
│   │   ├── .claude/          ← credentials desse user
│   │   ├── sessions/         ← sessions ativas
│   │   └── files/            ← arquivos uploadados
│   ├── user_def/
│   │   ├── .claude/
│   │   ├── sessions/
│   │   └── files/
```

Cada `claude -p` roda com `HOME=/home/claudecodeapi/users/{userId}` para isolar credentials.

### 2. Analise de arquivos nativo

Claude Code le arquivos do filesystem direto. Sem R2, sem S3, sem storage externo.

- User faz upload via `POST /upload` → arquivo salvo em `users/{userId}/files/`
- Claude Code le com FileReadTool nativo (ate 2000 linhas por read)
- Suporta: CSV, JSON, TXT, PDF, imagens, ZIP (extrai automatico)
- Sem limite de tamanho alem do disco
- Arquivos temporarios limpos apos 24h (cron)

```
POST /upload
Content-Type: multipart/form-data
Authorization: Bearer {user_token}

→ arquivo salvo em /users/{userId}/files/{filename}
→ Claude Code acessa via filesystem nativo
→ Zero configuracao extra
```

### 3. Quase de graca

Custo alvo: $0/mes de infra.

- VPS: Oracle Cloud Always Free (4 ARM cores, 24GB RAM, 200GB disco)
- Claude Code: subscription do user (nao nossa)
- DB: SQLite local (zero custo)
- SSL: Let's Encrypt (gratis)
- Domain: opcional (IP direto funciona)

Custo operacional: $0. Literalmente.

### 4. Inicializacao rapida

Cold start do `claude -p` é lento (~2-5s). Estrategias:

- **Session pool**: manter 2-3 processos claude "quentes" por user ativo
- **Lazy init**: primeiro request do user inicia o processo, requests subsequentes reutilizam
- **Pre-warm**: quando user faz login, ja inicia um processo em background
- **Session reuse**: `--continue` retoma session existente sem reinicializar
- **Bare mode**: `--bare` pula hooks, LSP, plugins — startup mais rapido

```
Primeiro request:  ~3s (cold start)
Requests seguintes: ~0.1s (session reutilizada)
```

## Dois modos de uso

### Modo Provider (LLM endpoint)

Drop-in replacement pra `api.anthropic.com`. O app manda mensagens, recebe respostas. Funciona com qualquer SDK que suporte endpoint customizado (Vercel AI SDK, LangChain, OpenAI-compatible, etc).

O user passa a chave OAuth dele (`sk-ant-oat01-...`) como API key. ClaudeCodeAPI autentica o processo claude com as credentials do user automaticamente.

```
// Qualquer app que use Anthropic SDK ou compativel:
{
  "llmProvider": "anthropic",
  "llmApiKey": "sk-ant-oat01-...",        // chave subscription do user
  "llmBaseUrl": "https://claudecodeapi.example.com"  // nosso endpoint
}

// O app nem sabe que por tras é o binario claude
// Pra ele é só "outro endpoint Anthropic"
```

### Modo Agent (agent completo)

Claude Code inteiro: agentic loop, file handling, MCP, context compaction, tools. O client manda uma task, o agent resolve sozinho com quantos steps precisar.

```
// Agent mode: manda task, recebe resultado completo
POST /agent
{
  "task": "analisa todos os CSVs e gera relatorio",
  "model": "opus",
  "mcp_config": { ... },
  "max_turns": 100
}

// Claude Code faz tudo: le arquivos, chama tools, compacta contexto, retenta erros
```

## Autenticacao por chave

O user passa a key da subscription dele no header Authorization:

```
Authorization: Bearer sk-ant-oat01-xxxxx
```

ClaudeCodeAPI:
1. Extrai o token OAuth do header
2. Escreve em /users/{hash}/. claude/.credentials.json
3. Spawna `claude -p` com `HOME=/users/{hash}`
4. Binario oficial usa as credentials → attestation valido → Opus funciona
5. Resposta volta pro client

O user nao precisa de VPS. Nao precisa instalar nada. Passa a key como faria com qualquer API.

## Endpoints

### Provider (LLM compativel)

| Method | Path | Descricao |
|--------|------|-----------|
| POST | /v1/messages | Compativel com Anthropic Messages API |
| POST | /v1/chat/completions | Compativel com OpenAI Chat API |

Ambos aceitam `Authorization: Bearer sk-ant-oat01-...` e roteiam pro binario claude.

### Agent (Claude Code completo)

| Method | Path | Descricao |
|--------|------|-----------|
| POST | /agent | Task completa com agentic loop |
| POST | /chat | Chat com session (multi-turn) |
| POST | /upload | Upload de arquivo pro workspace |
| GET | /sessions | Lista sessions ativas |
| DELETE | /sessions/:id | Encerra session |
| GET | /files | Lista arquivos |
| DELETE | /files/:name | Remove arquivo |
| GET | /usage | Uso (tokens, cost, sessions) |
| GET | /health | Health check |

### POST /v1/messages (Provider mode)

```json
// Request — mesmo formato da Anthropic API
{
  "model": "claude-opus-4-6",
  "max_tokens": 4096,
  "messages": [
    { "role": "user", "content": "explica recursao" }
  ],
  "stream": true
}

// Response — mesmo formato da Anthropic API (SSE)
event: message_start
data: {"type":"message_start","message":{"id":"msg_...","model":"claude-opus-4-6",...}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Recursao e..."}}

event: message_stop
data: {"type":"message_stop"}
```

Qualquer SDK que aponte pra `api.anthropic.com` funciona so trocando a baseUrl. Zero mudanca no codigo do client.

### POST /agent (Agent mode)

```json
// Request
{
  "task": "analisa o arquivo vendas.csv e gera insights",
  "session_id": "abc123",
  "model": "opus",
  "mcp_config": {
    "servers": {
      "meuapp": { "url": "https://..." }
    }
  },
  "system_prompt": "Voce e um analista de dados",
  "max_turns": 50,
  "stream": true
}

// Response (stream-json)
data: {"type":"text","content":"Analisando o arquivo vendas.csv..."}
data: {"type":"tool_use","name":"Read","input":{"file":"vendas.csv"}}
data: {"type":"tool_result","content":"id,produto,valor\n1,Widget,29.90\n..."}
data: {"type":"text","content":"O arquivo contem 300 registros..."}
data: {"type":"result","usage":{"input_tokens":1500,"output_tokens":800},"cost_usd":0.12,"session_id":"abc123"}
```

### POST /chat (Chat multi-turn)

```json
// Request
{
  "message": "agora filtra so vendas acima de R$100",
  "session_id": "abc123",
  "model": "opus",
  "stream": true
}

// Continua a conversa anterior com --continue
// Claude Code mantem contexto e faz compaction automatico
```

## Stack

- Runtime: Node.js (HTTP server) + child_process (spawna claude)
- VPS: Oracle Cloud Always Free (ARM, Ubuntu)
- DB: SQLite (sessions, usage tracking)
- SSL: Caddy ou Let's Encrypt
- Process manager: PM2
- Auth: JWT tokens por user

## Consumers

### Provider mode
- **SmoothAgent**: `llmBaseUrl: "https://claudecodeapi.example.com"` — drop-in
- **Vercel AI SDK**: `createAnthropic({ baseURL: "https://claudecodeapi.example.com" })`
- **LangChain**: trocar endpoint, funciona
- **Qualquer app**: compativel com Anthropic API ou OpenAI API
- **Cursor/Continue/etc**: apontar pra nosso endpoint

### Agent mode
- **SmoothAgent**: provider "claude-code" com agent completo
- **Automacoes**: CI/CD, code review, data analysis
- **Batch processing**: 300 arquivos? Claude Code resolve nativo
- **Apps custom**: qualquer coisa que precise de agent com tools

## Diferencial vs alternativas

| | API Anthropic | OpenClaw | ClaudeCodeAPI Provider | ClaudeCodeAPI Agent |
|--|---|---|---|---|
| Opus via subscription | Nao (per-token) | Bloqueado | **Sim** | **Sim** |
| Drop-in replacement | N/A | Nao | **Sim** | N/A |
| Context compaction | Nao | Reimplementado | Via binario | **5 camadas nativo** |
| File handling | Nao | Basico | Nao | **Nativo (filesystem)** |
| Agentic loop | Nao (SDK faz) | Reimplementado | Nao (SDK faz) | **Claude Code completo** |
| MCP nativo | Nao | Parcial | Nao | **Sim** |
| Attestation | N/A | Bypassado | **Real** | **Real** |
| Compativel com SDKs | Sim | Nao | **Sim** | API propria |
| Legal | Sim | Questionavel | **Sim** | **Sim** |
| Custo infra | $0 | VPS | **$0 (Oracle Free)** | **$0 (Oracle Free)** |

## Escalabilidade

### Fase 1: Oracle Free (0-8 concurrent, $0/mes)

```
1x Oracle Cloud Always Free (4 ARM cores, 24GB RAM)
├── ~8 containers gerando ao mesmo tempo
├── ~50 users registrados
├── Suficiente pra MVP e primeiros clientes
└── Custo: $0
```

### Fase 2: VPS unica maior (8-30 concurrent, $10-30/mes)

```
1x Hetzner CAX31 (8 ARM cores, 32GB RAM, ~$15/mes)
├── ~16 containers simultaneos
├── ~200 users registrados
├── Ou Oracle Cloud A1.Flex paid (~$20/mes)
└── Custo: $15-30/mes
```

### Fase 3: Horizontal (30-100+ concurrent, $30-100/mes)

```
Load Balancer (Caddy/Nginx, $5/mes)
├── VPS 1: users A-M (8 cores, $15/mes)
├── VPS 2: users N-Z (8 cores, $15/mes)
└── VPS 3: overflow  (8 cores, $15/mes)

Roteamento: hash(user_token) % num_servers → server fixo por user
Sessoes ficam no server do user (nao precisa de storage compartilhado)
```

### Custo por user

```
Oracle Free (Fase 1):
  50 users → $0/50 = $0.00/user/mes

Hetzner (Fase 2):
  200 users → $15/200 = $0.075/user/mes

Horizontal (Fase 3):
  500 users → $50/500 = $0.10/user/mes
  1000 users → $60/1000 = $0.06/user/mes
```

Custo por user CAI conforme escala. Margem cresce.

### Auto-scaling de containers

```
Monitorar: quantos containers ativos vs total CPU disponivel
Se CPU > 80%: rejeitar novos requests com 503 + "tente em Xs"
Se fila > 10: alertar para adicionar VPS
Cada container: max 30min de vida (long tasks), depois mata
Cleanup: containers orfaos limpos a cada 5min
```

## Modelo de negocio

ClaudeCodeAPI pode ser:
- **Self-hosted** (user roda no VPS dele, open source, $0)
- **Hosted por nos** (a gente roda, user so passa a key, cobra taxa)

Taxa hosted sugerida: $5-10/mes por acesso ao endpoint. O user economiza $100s em API tokens usando subscription. A gente cobra pela conveniencia de nao gerenciar VPS.

## Decisoes tecnicas criticas

### Processo claude por request vs persistente

```
Opcao A: spawn por request (simples, mais lento)
  request → spawn claude -p → resposta → processo morre
  Cold start: ~2-3s CADA request
  RAM: baixa (processos morrem)

Opcao B: pool de processos persistentes (complexo, rapido)
  login → cria processo claude interativo → fica vivo
  requests → pipe stdin/stdout → resposta instantanea
  Cold start: so no primeiro request
  RAM: alta (1 processo por user ativo ~100-200MB)

Opcao C: hibrido (recomendado)
  claude -p com --continue reutiliza session sem manter processo vivo
  Primeiro request: ~2-3s (cold start)
  Requests seguintes: ~1s (session cached em disco, sem processo ativo)
  RAM: baixa (processo morre apos cada request)
  O --continue carrega contexto do disco, nao da RAM
```

Recomendacao: **Opcao C**. Cada request spawna `claude -p --continue {session_id}`, Claude Code carrega o contexto do JSONL no disco, processa, morre. Sem processo persistente, sem consumo de RAM idle.

### Limites da Oracle Cloud Free (4 ARM cores, 24GB RAM)

```
RAM por processo claude: ~150-200MB
Max processos simultaneos: ~80-100 (24GB / 200MB = 120, margem 80%)
CPU por processo: ~0.5 core durante geracao
Max processos gerando ao mesmo tempo: ~8 (4 cores)

Conclusao: 8 users gerando resposta ao mesmo tempo
           80+ sessions carregando/processando
           Suficiente pra MVP e primeiros users
```

### Formato de output do `claude -p`

Flags essenciais:
```bash
claude -p "mensagem" \
  --output-format stream-json \     # streaming em tempo real
  --model opus \                     # modelo
  --continue \                       # retoma session
  --permission-mode bypassPermissions \  # sem prompts interativos
  --bare \                           # startup rapido (pula hooks/LSP)
  --add-dir /users/{id}/files \      # acesso aos arquivos do user
  --mcp-config /users/{id}/mcp.json  # MCP servers do user
```

Output format `stream-json` gera linhas JSON:
```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
{"type":"tool_use","name":"Read","input":{"file_path":"/users/abc/files/dados.csv"}}
{"type":"tool_result","content":"conteudo do arquivo..."}
{"type":"result","subtype":"success","duration_ms":2587,"total_cost_usd":0.045,"usage":{"input_tokens":3,"output_tokens":6},"session_id":"..."}
```

### Traducao Provider mode (Anthropic API compatible)

O desafio: traduzir output do `claude -p --output-format stream-json` pro formato SSE da Anthropic Messages API.

```
claude stream-json output          →    Anthropic SSE format
{"type":"assistant","message":...} →    event: message_start
{"type":"text_delta","text":"..."}  →    event: content_block_delta  
{"type":"result",...}              →    event: message_stop + usage
```

Implementar como um Transform stream que parseia linhas JSON do stdout e emite SSE no formato Anthropic. ~100 linhas de codigo.

### Seguranca e isolamento entre users (CRITICO)

O maior risco: com `--permission-mode bypassPermissions`, Claude Code acessa QUALQUER arquivo do sistema. Um user malicioso poderia pedir "leia /users/outro_user/.credentials.json".

#### Estrategia: Docker container por user

```
Cada request roda em container isolado:

docker run --rm \
  -v /data/users/{hash}/home:/home/claude \
  -v /data/users/{hash}/files:/workspace \
  --memory=512m \
  --cpus=1 \
  --network=none \          ← sem rede (MCP usa proxy do host)
  --read-only \             ← filesystem read-only exceto /home e /workspace
  claudecodeapi/sandbox \
  claude -p "mensagem" --output-format stream-json
```

Container garante:
- User A NAO ve arquivos do User B (volume mount isolado)
- User NAO acessa rede diretamente (proxy controlado)
- RAM limitada (512MB, nao come tudo)
- CPU limitada (1 core, fair share)
- Filesystem read-only (nao altera o host)

```
/data/
├── users/
│   ├── a1b2c3/              ← user A (hash do token)
│   │   ├── home/.claude/    ← credentials (montado como /home/claude)
│   │   └── files/           ← arquivos (montado como /workspace)
│   ├── d4e5f6/              ← user B (totalmente isolado)
│   │   ├── home/.claude/
│   │   └── files/
```

#### Imagem Docker leve

```dockerfile
FROM ubuntu:24.04-minimal
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://cli.claude.ai/install.sh | sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
USER claude
WORKDIR /workspace
ENTRYPOINT ["claude"]
```

Tamanho: ~200MB. Cold start container: ~500ms. Aceitavel.

#### MCP proxy isolado

Claude Code dentro do container nao tem rede (`--network=none`).
MCP calls saem via proxy Unix socket montado no container:

```
Container → /tmp/mcp-proxy.sock → Host → MCP server externo
```

O proxy no host valida e roteia. User A so acessa MCP servers configurados pra User A.

#### Seguranca das credentials

```
Protecoes:
  - Volume mount isolado por user (Docker)
  - {hash} = sha256(oauth_token)[0:16]
  - Credentials encriptadas em repouso (AES-256)
  - Token refresh: Claude Code faz automatico ao rodar
  - Cleanup: remover users inativos apos 30 dias
  - NUNCA logar tokens em stdout/logs
  - Container read-only: nao persiste nada fora dos volumes
```

### Compatibilidade OpenAI format

Muitos apps usam formato OpenAI. Traduzir:

```
POST /v1/chat/completions
{
  "model": "claude-opus-4-6",
  "messages": [{"role":"user","content":"oi"}],
  "stream": true
}

→ internamente vira claude -p com as mensagens
→ output traduzido pro formato OpenAI SSE
```

Isso permite que Cursor, Continue, LangChain, e qualquer app OpenAI-compatible use ClaudeCodeAPI sem mudanca.

## Proximos passos

1. Setup da VPS Oracle Cloud (gratis)
2. Instalar Claude Code + Node.js
3. Implementar Provider mode (POST /v1/messages — Anthropic-compatible)
4. Implementar Agent mode (POST /agent)
5. Testar multi-user com isolamento de credentials por chave OAuth
6. Implementar upload de arquivos
7. Session pool para cold start rapido
8. Compatibilidade OpenAI format (POST /v1/chat/completions)
9. Integrar como provider no SmoothAgent
10. SDK: `npm install claudecodeapi`
