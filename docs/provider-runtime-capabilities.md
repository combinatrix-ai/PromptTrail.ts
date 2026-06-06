# Provider and Runtime Capability Integration

This document defines how PromptTrail should integrate modern model APIs and
agent runtimes without losing PromptTrail's precise template-level control.

It is intentionally a design specification, not a changelog. Code should move
toward this document in small steps.

## Source Documents

- OpenAI Responses API: https://developers.openai.com/api/reference/responses/overview
- OpenAI tools guide: https://developers.openai.com/api/docs/guides/tools
- OpenAI Responses Skills: https://developers.openai.com/api/docs/guides/tools-skills
- OpenAI Responses Shell: https://developers.openai.com/api/docs/guides/tools-shell
- OpenAI Agents SDK: https://openai.github.io/openai-agents-python/
- OpenAI Codex SDK: https://developers.openai.com/codex/sdk
- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- Claude Agent SDK overview: https://code.claude.com/docs/ja/agent-sdk/overview
- Claude Agent SDK custom tools: https://code.claude.com/docs/en/agent-sdk/custom-tools
- Claude Agent SDK skills: https://code.claude.com/docs/en/agent-sdk/skills
- Claude tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Anthropic Agent Skills overview: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Anthropic Skills with the Claude API: https://platform.claude.com/docs/en/build-with-claude/skills-guide
- Google Gemini API libraries: https://ai.google.dev/gemini-api/docs/libraries
- Google GenAI SDK (JS/TS, `@google/genai`): https://github.com/googleapis/js-genai
- Google Agent Development Kit (ADK): https://adk.dev/

## Core Principle

PromptTrail has two integration surfaces:

1. **Model API adapters** run one model response under PromptTrail control.
   PromptTrail owns the session, loop, conditionals, retries, validation, tool
   execution, and message compaction.
2. **Agent runtime adapters** delegate one external runtime turn to another
   agent system. PromptTrail owns when the runtime is called and how results are
   merged back, but the runtime owns its internal loop, tools, filesystem
   actions, and approvals for that turn.

Do not merge these surfaces into a single provider `backend` switch. A model API
call and an agent runtime turn have different control semantics.

## Terminology

### Model API Adapter

A model API adapter is used by `Source.llm()` and `assistant()`. It returns a
PromptTrail assistant message and optional structured metadata.

Supported adapters (decided): exactly four.

- OpenAI Responses API (native)
- Anthropic Messages API (native)
- Google Gemini API (native)
- ai-sdk (first-class catch-all adapter for every other provider)

This is a deliberate scope decision: only OpenAI, Anthropic, and Google get
native deep-integration adapters. Every other provider is reached through the
ai-sdk adapter, which is a permanent, supported path — not a temporary
compatibility shim. PromptTrail does not write a native adapter per provider.

### Agent Runtime Adapter

An agent runtime adapter is a template primitive, like `codexTurn()`, that runs
one external agent turn and inserts the result back into the PromptTrail session.

Target adapters:

- `codexTurn()` for OpenAI Codex App Server
- `claudeTurn()` for Claude Agent SDK

### Capability

A capability is anything that can change what a model or runtime can do.
Capabilities are broader than tools.

```ts
export type Capability =
  | PromptTrailTool
  | RuntimeSkill
  | BuiltinTool
  | McpServer;
```

### Tool

A tool is a schema-defined callable with an executable handler and a returned
result. The handler always runs in the PromptTrail process. Depending on the
adapter, PromptTrail either calls it directly or services an execution request
that the model/runtime sends back to it (see Tool Execution Mechanics).

```ts
export interface PromptTrailTool<TInput = unknown, TResult = unknown> {
  kind: 'tool';
  name: string;
  description: string;
  // Zod schema. Converted to JSON Schema for Responses/Codex, used natively by
  // the Claude Agent SDK's tool() helper. Do not weaken this to `unknown`:
  // type inference for the handler input depends on it.
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TResult>;
  approval?: ApprovalPolicy;
  metadata?: Record<string, unknown>;
}
```

`Tool.create()` should eventually return this native PromptTrail type. ai-sdk
tool objects can remain supported through an adapter, but they should not be the
core tool representation.

Result mapping: every adapter ultimately needs an MCP-style `CallToolResult`
(`{ content, structuredContent?, isError? }`). The Claude Agent SDK and Codex
App Server both expect this shape; the Responses/Messages loops can derive it
from `TResult`. The native tool layer must therefore map a free-form `TResult`
into `CallToolResult` and normalize errors: a thrown handler error must become
`isError: true` rather than propagating, because the Claude Agent SDK treats an
uncaught throw as a fatal end to the agent loop.

### Skill

A skill is not a callable function. It is a workflow or instruction bundle that
may include extra files, examples, references, scripts, or tool dependencies.

```ts
export interface RuntimeSkill {
  kind: 'skill';
  name: string;
  description?: string;
  instructions?: string;
  path?: string;
  // Provider-native skill reference (e.g. Anthropic Messages `container.skill_id`,
  // a pre-built id like 'pptx' or an uploaded custom skill id). When set, the
  // adapter can pass the skill natively instead of injecting instructions.
  skillId?: string;
  materialize?: 'never' | 'workspace' | 'temporary';
  metadata?: Record<string, unknown>;
}
```

Provider mapping differs:

- Codex App Server can receive skill input items after resolving `skills/list`.
- Claude Agent SDK discovers skills from `.claude/skills` and can filter them
  with the SDK `skills` option.
- Anthropic Messages API supports skills natively (verified). A skill is passed
  by `skill_id` in the `container` parameter together with the code execution
  tool; the skill runs in Anthropic's code execution container (`provider`
  execution mode), not as injected text. Anthropic's API docs list three beta
  headers as prerequisites for API Skills: `code-execution-2025-08-25`,
  `skills-2025-10-02`, and `files-api-2025-04-14`. The third header is described
  as supporting file upload/download to and from the container, but PromptTrail
  should still send all three for native Anthropic Skills unless Anthropic
  documents a narrower invocation-only contract. Pre-built skills (`pptx`,
  `xlsx`, `docx`, `pdf`) are referenced by id; custom skills must first be
  uploaded via the Skills API (`/v1/skills`), which returns a workspace-scoped
  id. The API container has no network access and no runtime package
  installation.
- OpenAI Responses API supports skills through shell tool environments, not as a
  top-level model primitive. Hosted shell can mount uploaded skill references
  via `tools[].environment.skills`; local shell can expose local skill paths.
  `RuntimeSkill` must not implicitly enable the shell tool: some skills are
  instruction-only, and shell/container execution changes the permission,
  cost, and data-exposure boundary. When no compatible shell/runtime capability
  is explicitly enabled, skills fall back to instruction injection (see
  lossy-injection note below).
- For any adapter that falls back to instruction injection, only the
  `instructions` text is conveyed; `path`, bundled files, and scripts are
  dropped. The adapter must `warn` (or `error` under a strict policy) when a
  skill carrying files/scripts is injected as text, so the loss is not silent.

Materialization strategy (decided): there is **no** shared `.prompttrail/skills`
intermediate layer. Each target consumes skills through a different mechanism —
Anthropic native uploads via `/v1/skills` (no filesystem), Codex passes a skill
input item, and only the Claude Agent SDK reads filesystem `.claude/skills`. A
common intermediate directory would therefore serve exactly one target, so a
PromptTrail-defined skill is materialized **directly** into each target's
expected form (workspace `.claude/skills` for the Claude Agent SDK; `/v1/skills`
upload for Anthropic; skill input item for Codex), each gated by explicit
approval. Filesystem materialization stays inside the workspace unless approved
otherwise.

### MCP Server

An MCP server is a remote or local tool namespace. PromptTrail should represent
it separately from individual tools because providers and runtimes often have
native MCP support.

```ts
export type McpTransport =
  | {
      kind: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { kind: 'http'; url: string; headers?: Record<string, string> }
  | { kind: 'sdk-in-process'; server: unknown }; // e.g. createSdkMcpServer() result

export interface McpServer {
  kind: 'mcp';
  name: string;
  transport: McpTransport;
  tools?: 'all' | string[];
  approval?: ApprovalPolicy;
}
```

Like `inputSchema`, `transport` should be a typed union, not `unknown`. The
`sdk-in-process` variant carries an in-process MCP server (such as the Claude
Agent SDK's `createSdkMcpServer()` result) and reuses the same tool-execution
path as a `PromptTrailTool`.

MCP WebSocket transport is deferred. Do not model it as a first-class transport
until a target provider/runtime requires WebSocket MCP specifically. Keep it
separate from the Codex App Server WebSocket transport.

### Builtin Tool

A builtin tool is provider-hosted or runtime-hosted. PromptTrail configures it
but does not execute it.

Examples:

- OpenAI Responses built-ins such as web search or file search
- Claude server tools
- Codex and Claude runtime filesystem/shell tools

### Subagent

PromptTrail already has `subroutine()` for precise nested control. External
agent runtimes may also expose subagents, but `SubagentDefinition` is deferred
and should not be part of the core `Capability` union yet.

Reason: tools, skills, builtin tools, and MCP servers describe abilities that a
turn may use. Subagents describe delegation to another execution structure. That
overlaps PromptTrail's own `subroutine()` and the deferred general agent
frameworks (`agentsTurn()` / `adkTurn()`), so adding `withCapabilities([subagent])`
now would blur PromptTrail-owned nested control and runtime-owned delegation.
If a runtime-specific subagent surface becomes important, add it first as a
runtime adapter option (for example, `codexTurn({ subagents: [...] })`) after
verifying the provider/runtime API.

## Execution Modes

Every capability must resolve to one of three execution modes.

| Mode          | Owner                                      | Examples                                                                                      |
| ------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `prompttrail` | PromptTrail executes and appends results   | Responses function tools, Anthropic client tools, custom tools given to Codex/Claude runtimes |
| `provider`    | Model provider executes internally         | OpenAI built-in tools, Claude server tools                                                    |
| `runtime`     | External agent runtime executes internally | Codex shell/filesystem, Claude Code built-in tools                                            |

This distinction is required for approval, logging, retry, and deterministic
test behavior.

Important: a `PromptTrailTool` (a custom tool with a handler) is **always**
`prompttrail` mode, including when it is passed into `codexTurn()` or
`claudeTurn()`. The runtime never executes the handler; it only decides when to
call it and then asks PromptTrail to run it. Only built-in tools (shell,
filesystem, web search) are `runtime`/`provider` mode. So the execution mode of
a custom tool is a property of the tool, not the adapter — what changes per
adapter is the _delivery path_ that gets PromptTrail's handler invoked.

### Tool Execution Mechanics

The same `PromptTrailTool` reaches its handler through three different paths.
The handler runs in the PromptTrail process in all three.

| Adapter              | How the tool is registered                      | How the handler is invoked                                                                                                                                              |
| -------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responses / Messages | function/tool definition in the request         | PromptTrail's own tool loop: read `tool_use`/function call from the response, run handler, append result                                                                |
| Claude Agent SDK     | `createSdkMcpServer()` + `mcpServers` option    | In-process MCP server; the SDK calls the handler directly. No network hop. Result is an MCP `CallToolResult`. Pre-approve via `allowedTools: ['mcp__{server}__{tool}']` |
| Codex App Server     | `dynamicTools` on `thread/start` (experimental) | Bidirectional JSON-RPC: the server sends an `item/tool/call` request back to the client; the client runs the handler and replies with content items                     |

Consequence for Codex: PromptTrail must act as a JSON-RPC _server_ for the
duration of the turn — it has to accept server-initiated requests
(`item/tool/call`, and the approval requests `item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`, `tool/requestUserInput`) and answer them.
The current WebSocket client only resolves its own outbound requests by id and
handles a few notifications; it has no inbound-request handler. That inbound
channel is a prerequisite before `capabilities: [tool]` or any non-`never`
approval policy can work on `codexTurn()`.

Consequence for the Claude Agent SDK: the SDK hides this entirely behind the
in-process MCP server, so the integration cost is much lower — but the handler
must return a `CallToolResult` and must not throw (a throw ends the agent loop).

## Common Session Representation

Provider and runtime details must not be flattened into plain text. PromptTrail
messages should keep a stable common shape plus provider-specific raw metadata.

```ts
export interface RuntimeTurnResult {
  provider: 'codex' | 'claude-agent';
  threadId?: string;
  turnId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  finalAnswer: string;
  events: RuntimeEvent[];
  raw?: unknown;
}

export interface ProviderResponseMetadata {
  provider: 'openai' | 'anthropic' | 'google';
  api: 'responses' | 'messages' | 'chat' | 'gemini';
  responseId?: string;
  stopReason?: string;
  outputItems?: unknown[];
  usage?: unknown;
  raw?: unknown;
}
```

Recommended message attrs:

- `message.attrs.openai` for OpenAI Responses metadata
- `message.attrs.anthropic` for Anthropic Messages metadata
- `message.attrs.google` for Google Gemini metadata
- `message.attrs.codex` for Codex App Server turn metadata
- `message.attrs.claudeAgent` for Claude Agent SDK turn metadata

## Conversation State

Some providers and runtimes keep their own server-side copy of the conversation
and let you continue it by reference instead of resending history:

- OpenAI Responses: `previous_response_id` (and the Conversations API).
- Codex App Server: `threadId`.
- Claude Agent SDK: session / resume id.

Anthropic Messages and Google Gemini are stateless, so this concept is a no-op
for them: PromptTrail always resends the converted history.

This server-side state creates a second source of truth, which conflicts with
PromptTrail's immutable, locally-owned session. The decided rules resolve that
conflict:

1. **PromptTrail messages are always canonical.** Server-side state is only a
   send-time optimization (reference an id instead of resending full input). It
   is never the source of truth.
2. **No provider state on the `Session` type.** The session is not parameterized
   by provider and gains no mutable "current response id" field. Continuation is
   derived from the last assistant message's provider metadata
   (`attrs.openai.responseId`, `attrs.codex.threadId`, ...). This keeps the
   session immutable and makes forking/branching correct for free: each branch's
   last message carries its own id, so each branch continues the right chain.
3. **Opt-in is conversation-scoped, not source-scoped.** Whether to use
   server-side continuation is a property of the whole conversation, expressed
   as a single provider-neutral option, not a per-`Source.llm()` toggle. A
   per-source flag is rejected: it would let turns in one session disagree about
   whether the server is tracking state, which is incoherent.
4. **Divergence falls back to stateless.** If local history has been compacted,
   edited, or branched since the referenced response/thread, the adapter must
   drop the reference and send full input (starting a fresh server chain).
   "PromptTrail history wins."

Generalize all three under one provider-neutral concept — a `ConversationBinding`
(opaque `{ provider, id }` derived from message metadata, never authoritative).
The existing `codexTurn()` thread handling is one instance of this binding.

## Metadata Retention

Immutable sessions accumulate every turn, so embedding full raw provider
payloads (Responses output items, Anthropic content blocks, Codex items/events,
runtime diffs and command logs) in each message bloats memory and `toJSON()`
output. The model decouples **live observability** from **persisted state**.

Decided design — one common knob across every model-API adapter and runtime
turn, including `codexTurn()` and `claudeTurn()`:

```ts
retain?: 'none' | 'summary' | 'full'; // default 'summary'
```

Levels:

- `none`: keep only the canonical assistant text / `finalAnswer`, plus the
  `ConversationBinding` id and status. The binding id must survive even here,
  because conversation continuation derives from it (see Conversation State).
- `summary` (default): binding id, status, `stopReason`/`finishReason`, usage,
  and a summarized list of items/events — each `{ type, id, status, preview }`
  with content truncated (default 500 chars). No `raw`.
- `full`: everything, including `raw` provider payloads.

Two rules keep this safe:

1. **Large artifacts by reference, not inline.** Diffs and command logs are
   never embedded in full at the default level. `summary` keeps a stat only —
   a diff becomes `{ path, added, removed, status }`; a command becomes
   `{ command, exitCode, status, outputPreview }`. Full-fidelity diffs/logs are
   delivered live through `onEvent`; if a caller needs them persisted, it
   captures them from `onEvent` into its own sink and correlates by event id.
   This is the answer to "how to expose runtime diffs without bloating messages."
2. **No silent truncation.** Any summarized or truncated field is flagged
   (`truncated: true`, `fullLength: N`) so a summary never reads as if it were
   the complete payload.

This applies uniformly: `attrs.openai.outputItems`, `attrs.anthropic.content`,
`attrs.google`, and `attrs.codex`/`attrs.claudeAgent` events all follow the same
`retain` levels and the same summary shape.

### Replay-required pins

`retain` has a hard floor. Some provider artifacts must be replayed back to the
provider **unchanged** on a later request, so they cannot be summarized or
dropped even at `retain: 'summary'` or `'none'`:

- Signed thinking blocks (Anthropic `signature`, Gemini `thoughtSignature`).
- Encrypted reasoning items (OpenAI `encrypted_content` in stateless mode).
- Opaque compaction artifacts (OpenAI encrypted compaction item, Anthropic
  `compaction` block).

Rule: any artifact marked **replay-required** is pinned and overrides `retain`
for as long as the adapter may replay that provider turn to the same provider.
Closing the turn is not enough by itself: if a later stateless request will
include an earlier assistant message that contained signed/encrypted thinking,
the unchanged provider artifact must still be available. `retain` may drop the
artifact only when replay is no longer needed — for example, a
`ConversationBinding` makes the provider hold the state server-side, the
conversation is ending, or the adapter is intentionally falling back to
PromptTrail-only canonical history and will not replay provider-specific
reasoning/compaction artifacts. These pinned artifacts are always treated as
binding-scoped, opaque, and non-portable (see Reasoning and Thinking,
Compaction).

## Generation Capabilities

These behaviors cut across the native model API adapters. Each exposes a single
provider-neutral PromptTrail option that maps to per-provider mechanisms, and
each interacts with `retain`, `ConversationBinding`, and the replay-required
pin. The `ai-sdk` adapter provides best-effort coverage; deep behavior is a
native-adapter guarantee.

### Structured Output

`Source.schema(zodSchema)` is the entry point. Per provider:

- OpenAI Responses: `text.format = { type: 'json_schema', name, schema, strict }`.
  Strict mode requires every property in `required` and
  `additionalProperties: false` on every object; emulate optional fields with
  nullable unions. Refusals surface in a `refusal` field.
- Anthropic Messages: native `output_config.format = { type: 'json_schema',
  schema }`, or the older forced-tool path (`tool_choice: { type: 'tool', name }`
  + `input_schema`). No recursion, no numeric/length constraints,
  `additionalProperties` must be `false`.
- Google Gemini: `responseMimeType: 'application/json'` +
  `responseJsonSchema` (or the narrower `responseSchema`); `propertyOrdering`
  controls field order.
- ai-sdk: `generateObject` / `streamObject`.

Decided mapping: keep ai-sdk `generateObject` as the cross-provider default
(convert Zod → JSON Schema once). Add an opt-in `mode: 'native' | 'tool'` that
targets each provider's native field. A shared **Zod → JSON Schema
normalization** layer is required because no single output satisfies all
dialects: inject `additionalProperties: false`, rewrite optionals to nullable
unions for OpenAI strict, and strip (or error on) the recursion/numeric
constraints Anthropic rejects.

Key interaction: structured final output with an active tool loop is
provider-specific. Anthropic supports the forced-tool path naturally. OpenAI
Responses supports a function-tool loop followed by a final structured message
because `tools` and `text.format` are both request fields. Gemini rejects forced
function calling (`ANY`) when `responseMimeType: 'application/json'` is on the
same request, so the Gemini native adapter omits `responseJsonSchema` on the
initial required-tool request and restores it on the post-tool continuation
request. Native adapter tests cover this sequencing; real Gemini tests are
still subject to provider quota.

### Streaming

Normalize every provider stream into one discriminated event type, parsed at the
adapter boundary (extends the `RuntimeEvent` idea):

```ts
type PromptTrailStreamEvent =
  | { type: 'text.delta'; index: number; delta: string }
  | { type: 'reasoning.delta'; index: number; delta: string }
  | { type: 'tool.start'; index: number; callId: string; name: string }
  | { type: 'tool.args.delta'; index: number; callId: string; delta: string }
  | { type: 'tool.args.done'; index: number; callId: string; args: unknown }
  | { type: 'message.done'; finishReason: string; usage?: unknown }
  | { type: 'error'; error: unknown };
```

Mapping: OpenAI `response.output_text.delta` / `function_call_arguments.delta` /
`reasoning_summary_text.delta` / `response.completed|failed|incomplete`;
Anthropic `text_delta` / `input_json_delta` / `thinking_delta` /
`message_stop`; Gemini incremental text parts, `thought` parts, and **atomic
`functionCall`** (no argument deltas — emit `tool.start` + a single
`tool.args.done`).

Interactions: the tool loop accumulates `tool.args.delta` per `callId` and parses
at `tool.args.done` (never mid-stream — Anthropic `input_json_delta` is invalid
JSON until block stop). The persisted message is produced by a **reducer over
the event stream**, so `retain` controls what is stored independently of what is
streamed live. Structured-output streaming only validates against the Zod schema
at completion.

### Reasoning and Thinking

Common option `thinking: { effort?: 'low'|'medium'|'high'; budgetTokens?: number;
summary?: boolean }`:

- OpenAI: `reasoning.effort` + `reasoning.summary`; output is a `reasoning`
  item. In stateless / zero-data-retention replay mode, add
  `reasoning.encrypted_content` to `include` and pin the returned
  `encrypted_content`; resend each required reasoning item between the function
  call and its output. With `previous_response_id`, the server-side binding can
  hold this state instead.
- Anthropic: `thinking: { type: 'enabled', budget_tokens }`; `thinking` blocks
  carry a `signature` and **must be replayed unchanged, in order, before the
  `tool_use` block**; non-decryptable ones are `redacted_thinking`. Only
  `tool_choice: auto | none` allowed.
- Gemini: `thinkingConfig: { thinkingBudget, includeThoughts }`; parts carry
  `thought: true` and `thoughtSignature`; return all parts/signatures intact.

Store artifacts in `attrs.<provider>`. The critical rule is the
**replay-required pin** above: signed/encrypted reasoning cannot be dropped by
`retain` while the adapter may need to replay that same provider turn. Per
provider: Anthropic and Gemini pin signed thinking whenever previous thinking
blocks are included in later stateless history; OpenAI pins encrypted reasoning
only when `encrypted_content` is requested and no server-side binding can hold
the state.

### Prompt Caching

A per-message / per-capability `cache` hint (the Anthropic breakpoint model is
the most expressive, so it is the common shape): `cache: true | '5m' | '1h' |
'persist'`.

- Anthropic: emit `cache_control: { type: 'ephemeral', ttl }` on the marked
  block; cap at 4 breakpoints (longer TTL first); min ~1024 tokens.
- OpenAI: caching is automatic/prefix-based, so placement is ignored; the hint
  only derives a stable `prompt_cache_key`.
- Gemini: when a contiguous cacheable prefix exceeds the threshold, lazily call
  `caches.create` once, store the returned `cachedContent` name in session vars,
  and pass `cachedContent` on later turns. Any `systemInstruction` and `tools`
  that should be cached must be included when creating the cache; they cannot be
  added beside `cachedContent` on the later generation request.

Sub-threshold hints are silent no-ops (do not error). Immutability is an asset
here: PromptTrail's append-only sessions form a stable growing prefix, which is
exactly what prefix caching rewards — keep system/tools/few-shot at the head and
variable data at the tail. Expose a session-level `cacheKey` to feed OpenAI's
`prompt_cache_key` and to namespace Gemini `CachedContent` reuse. Caching is
orthogonal to `ConversationBinding` (state vs token cache), though Gemini's
`cachedContent` name is itself a binding-like handle stored alongside it.

### Multimodal Input

Introduce a provider-neutral message content-part model:

```ts
type ContentPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'image' | 'file' | 'audio';
      mimeType: string;
      source:
        | { type: 'bytes'; data: Uint8Array | string /* base64 */ }
        | { type: 'uri'; uri: string }
        | { type: 'providerFile'; provider: string; fileId: string };
      detail?: 'low' | 'high' | 'auto';
      filename?: string;
    };
```

Adapters serialize: OpenAI `input_image` / `input_file` (uri → `image_url`,
providerFile → `file_id`); Anthropic `image` / `document` source variants;
Gemini `inlineData` (bytes) / `fileData` (uri/providerFile). Delegate to ai-sdk's
`image` / `file` parts where possible.

Interaction with `retain`: never persist `bytes` inline in immutable sessions —
default to storing a `uri` or `providerFile` reference and cache the uploaded
id in `attrs.<provider>` so re-sends reference instead of re-encoding. Files API
lifecycle is asymmetric and must be an explicit policy: **Gemini files expire
after 48h** (breaking long-lived sessions), Anthropic/OpenAI persist until
deleted. Treat provider file refs as ephemeral, track expiry, re-upload on miss,
and decide cleanup ownership (framework vs caller) explicitly. A `providerFile`
id is non-portable, so a session reused on another provider re-uploads.

### Compaction

Provider/runtime mechanisms: OpenAI `context_management.compact_threshold`
(automatic in-stream, emits an encrypted compaction item); Anthropic beta
`context_management.edits: [{ type: 'compact_20260112', trigger,
pause_after_compaction }]` (emits a `compaction` block, auto-drops earlier
blocks); Gemini has no API-level compaction (only caching); agent runtimes
(Codex, Claude Agent SDK) compact internally per turn.

Decided stance: **PromptTrail's local history stays canonical; provider-side
compaction is opt-in and never mutates the session.** Default off — PromptTrail's
own compaction plus immutable history win, consistent with the
`ConversationBinding` "history wins" rule. A provider compaction artifact is
stored as a binding-scoped opaque sidecar (like `previous_response_id`), not as
canonical messages. Expose `compaction: { mode: 'provider' | 'local' | 'off';
threshold? }` so truncation has exactly one owner — never both silently.

Interactions: on a stateless fallback the opaque artifact is unusable, so
PromptTrail replays from its full canonical history (re-compacting locally if
needed). `retain`-flagged messages must be re-injected **after** any provider
summary so a server-side drop cannot evict them.

## Model API Adapters

### OpenAI Responses API

Current state:

- `Source.llm().openai()` defaults to `api: 'responses'`.
- The implementation uses ai-sdk's OpenAI provider and
  `openai.responses(model)`.

Target state:

- Keep ai-sdk as a compatibility path.
- Add a native Responses adapter for deep integration.

Native Responses requirements:

- Preserve `response.id` as `attrs.openai.responseId`.
- Preserve output items as `attrs.openai.outputItems`, subject to the `retain`
  level (summary by default; `raw` only at `full`).
- Support `previous_response_id` per the Conversation State rules: derive it from
  the last assistant message's `attrs.openai.responseId`, treat it as a send
  optimization only, and fall back to stateless full input on any history
  divergence.
- Support stateless mode by converting PromptTrail messages into `input` items
  (this is also the divergence fallback).
- Translate `PromptTrailTool` to Responses function tools.
- Execute PromptTrail-owned function calls in a deterministic tool loop.
- Preserve built-in tool calls and provider-hosted results in raw metadata.
- Support remote MCP tools as provider-native tools when configured.
- Support Responses streaming events as first-class metadata and loop inputs:
  at minimum `response.output_item.added`, `response.output_item.done`,
  `response.function_call_arguments.delta`,
  `response.function_call_arguments.done`, `response.completed`,
  `response.failed`, `response.incomplete`, and `response.error`.
- Preserve modern Responses output/input item types including
  `function_call`, `function_call_output`, `tool_search_call`,
  `tool_search_output`, `additional_tools`, MCP call/list/approval items, shell
  calls, custom tool calls, and provider built-in call outputs. Unknown item
  types must be retained in raw metadata rather than dropped.
- Surface reasoning, citations, annotations, and tool call results without
  forcing them into assistant text.

Recommended API:

```ts
Source.llm()
  .openai({ api: 'responses', adapter: 'native' })
  .withCapabilities([weatherTool, webSearchTool, docsMcp]);
```

Compatibility:

- `adapter: 'ai-sdk'` should remain available while native coverage matures.
- Existing `providerOptions` and `sdkOptions` should continue to work only for
  the ai-sdk path.

### Anthropic Messages API

Current state:

- `Source.llm().anthropic()` uses the ai-sdk Anthropic provider.

Target state:

- Keep ai-sdk as a compatibility path.
- Add a native Anthropic Messages adapter for deep tool and content-block
  metadata.

Native Anthropic requirements:

- Translate PromptTrail messages into Anthropic `messages` plus `system`.
- Translate `PromptTrailTool` to Anthropic tools with `input_schema`.
- Execute `tool_use` blocks and append `tool_result` blocks under PromptTrail
  control.
- Preserve content blocks as `attrs.anthropic.content`.
- Preserve `stop_reason`, usage, model, and raw response metadata.
- Support Anthropic tool choice modes through a provider-specific option while
  keeping PromptTrail's common `toolChoice` mapping.
- Support native skills: when a `RuntimeSkill` has a `skillId`, pass it via the
  `container` parameter with the code execution tool and the required beta
  headers listed by Anthropic for API Skills (`code-execution-2025-08-25`,
  `skills-2025-10-02`, `files-api-2025-04-14`), rather than injecting
  instructions. Optionally support uploading a PromptTrail-defined skill through
  the Skills API (`/v1/skills`) to obtain an id, gated behind explicit approval
  since it publishes the skill workspace-wide. Account for the container's
  no-network / no-package-install constraints.

Recommended API:

```ts
Source.llm()
  .anthropic({ adapter: 'native' })
  .model('claude-sonnet-4-6')
  .withCapabilities([weatherTool]);
```

### Google Gemini API

Current state:

- `Source.llm().google()` uses the ai-sdk Google provider.

Target state:

- Add a native Gemini adapter so Google is a first-class deep-integration
  provider alongside OpenAI and Anthropic.
- Build it on the official Google GenAI SDK, `@google/genai` (repo
  `googleapis/js-genai`, GA since May 2025). Do not use the legacy
  `@google/generative-ai` package: it is deprecated (end of support
  2025-11-30) and lacks recent features. Verify whether ai-sdk's Google provider
  already tracks `@google/genai` so the ai-sdk path and the native path do not
  diverge on SDK version.

Native Gemini requirements:

- Translate PromptTrail messages into Gemini `contents` plus `systemInstruction`.
- Translate `PromptTrailTool` to Gemini function declarations (JSON Schema
  derived from the Zod `inputSchema`).
- Execute `functionCall` parts and append `functionResponse` parts under
  PromptTrail control.
- Preserve candidates, `finishReason`, safety ratings, and usage metadata as
  `attrs.google` raw metadata.
- Support provider-hosted built-ins (e.g. Google Search grounding, code
  execution) as `BuiltinTool` values without forcing results into assistant text.
- Skills map to instruction injection: Gemini has no first-class skill primitive,
  so apply the lossy-injection warn/error rule when a skill carries files.

Recommended API:

```ts
Source.llm()
  .google({ adapter: 'native' })
  .model('gemini-3.1-flash-lite')
  .withCapabilities([weatherTool]);
```

### ai-sdk Adapter

ai-sdk is the fourth supported adapter: the catch-all transport for every
provider that does not have a native adapter (everything except OpenAI,
Anthropic, and Google). It is a permanent, first-class path, not a temporary
shim. It is also where PromptTrail relies on ai-sdk's cross-provider streaming,
tool-call, and structured-output normalization instead of reimplementing it.

Policy (decided, assuming no backward-compatibility constraint):

- ai-sdk is removed from the core abstraction. `PromptTrailTool` is the single
  core tool type; ai-sdk tool objects are an internal detail of the ai-sdk
  adapter only, reached through a one-way `PromptTrailTool -> ai-sdk` mapping.
- ai-sdk is removed from the public surface. `providerOptions` / `sdkOptions`
  and other raw ai-sdk objects are not part of the stable API; they live behind
  the ai-sdk adapter.
- For OpenAI, Anthropic, and Google, the native adapter becomes the default the
  moment that provider's native adapter reaches parity — switched per provider as
  each lands, not on a fixed release schedule and with no one-release ai-sdk
  grace period (backward compatibility is not a constraint). `adapter: 'ai-sdk'`
  stays available as an explicit escape hatch, but is not the default for these
  three once default parity is reached.
- Default parity is the minimum required to switch defaults: text generation,
  streaming, the PromptTrail-owned tool loop, structured output, error mapping,
  and basic metadata retention all verified against the ai-sdk path.
- Deep parity is not a default-switch blocker. It is native-only coverage added
  incrementally after default parity: exact provider output items/events,
  reasoning/citations/annotations, provider-hosted tools, remote MCP,
  `tool_search` / `additional_tools`, shell-backed skills, and other
  provider-specific advanced surfaces.
- Deep-integration features (exact item/tool/reasoning/approval/event metadata)
  are only guaranteed on native adapters; the ai-sdk adapter provides
  best-effort metadata.
- Native adapters expose a stable PromptTrail API, never provider SDK objects
  directly.

Why not delete ai-sdk entirely: removing it would force either writing and
maintaining a native adapter per long-tail provider, or dropping multi-provider
support to just OpenAI/Anthropic/Google. Keeping ai-sdk as one contained,
non-core adapter preserves provider breadth at low maintenance cost. Full
removal is only on the table if PromptTrail decides to support exactly the three
native providers and nothing else.

## Agent Runtime Adapters

### Codex App Server

Current state:

- `codexTurn()` can connect to a WebSocket Codex App Server.
- It starts a thread, starts a turn, collects events, and appends the final
  answer to the session.
- Live integration tests run only when a server is reachable.

Target state:

- Treat Codex App Server as an agent runtime template, not an OpenAI provider
  backend.

Relationship to the Codex SDK: the public TypeScript Codex SDK is a
higher-level wrapper around the Codex CLI (`startThread()` / `run()` /
`runStreamed()` / thread resume / sandbox policy). It exposes useful turn and
streaming primitives, but its documented TypeScript API does not currently
expose PromptTrail-owned dynamic tool handlers, approval callbacks, MCP
registration, or skill registration as public inputs. The App Server protocol is
therefore the primary capability surface for `codexTurn()` deep integration.
The Codex SDK remains an implementation option for simple turns:

- Raw App Server protocol (current): no extra dependency, but PromptTrail must
  implement the inbound JSON-RPC channel itself.
- Codex SDK wrapper: less thread/turn/streaming boilerplate, at the cost of a
  pinned Codex CLI dependency and less direct access to experimental App Server
  capabilities.

If the Codex SDK later exposes `dynamicTools` / `item/tool/call` equivalents as
public API, it can share the same capability model. Until then, custom tools,
runtime approvals, and skills should be implemented against the App Server
protocol directly.

Required additions:

- **Inbound JSON-RPC request handling (prerequisite).** The current client only
  resolves outbound requests by id and handles notifications. To support custom
  tools and approvals the client must accept server-initiated requests and reply
  to them: `item/tool/call` (custom tool execution),
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  and `tool/requestUserInput`. Without this channel, only
  `approvalPolicy: 'never'` and zero custom tools can work. Build this before
  the items below.
- `onEvent` callback for streaming runtime events. This is the full-fidelity
  channel for diffs and command logs (see Metadata Retention); the persisted
  session keeps only the `retain`-level summary.
- Stable `RuntimeEvent` normalization for item started/completed, deltas,
  command events, diffs, approvals, errors, and turn completion. Each event
  carries an id so a `summary`-level stat can be correlated back to the full
  artifact captured via `onEvent`.
- Use the common `retain: 'none' | 'summary' | 'full'` knob (default
  `summary`) for persisted Codex items/events.
- Thread reuse and explicit thread persistence.
- Skill resolution through `skills/list`.
- Skill input item insertion for requested `RuntimeSkill` values.
- Dynamic tool support for `PromptTrailTool` via `dynamicTools` on
  `thread/start` (experimental API). PromptTrail keeps the handler and answers
  each `item/tool/call` with content items; the App Server persists the tool
  definitions in thread metadata and restores them on resume.
- Approval handling through a common `ApprovalHandler`, driven by the inbound
  approval requests above.
- Unix socket and stdio transports after WebSocket.

Recommended API:

```ts
Agent.create()
  .user('Inspect this repository and propose a minimal patch')
  .codexTurn({
    transport: { kind: 'websocket', url: 'ws://127.0.0.1:8390' },
    cwd: process.cwd(),
    sandboxPolicy: { type: 'readOnly' },
    approvalPolicy: 'never',
    capabilities: [reviewSkill, repoDocsMcp],
    onEvent: (event) => console.log(event),
  });
```

### Claude Agent SDK

Claude Agent SDK should be modeled as `claudeTurn()`, parallel to
`codexTurn()`. It is not a replacement for `Source.llm().anthropic()`.

Key integration facts:

- The SDK runs the agent loop in the user's process or infrastructure.
- It exposes TypeScript and Python SDKs.
- It can use built-in Claude Code style tools.
- SDK skills are filesystem artifacts under `.claude/skills` or user-level
  skill directories. The SDK `skills` option filters available skills; it does
  not replace a general in-memory skill registry.

Target requirements:

- Optional dependency on the Claude Agent SDK package.
- Convert the last PromptTrail user message, or explicit `input`, into a SDK
  query prompt.
- Preserve streamed SDK messages/events as `attrs.claudeAgent.events`.
- Expose `PromptTrailTool` values as an in-process MCP server via
  `createSdkMcpServer()` and pass it through the `mcpServers` option. The
  handler runs in-process (no callback channel needed, unlike Codex). Each tool
  becomes `mcp__{server}__{tool}`; add it to `allowedTools` to skip the
  permission prompt. The native tool layer must return a `CallToolResult` and
  convert handler exceptions to `isError: true` so a tool failure does not abort
  the whole SDK query.
- Map `allowedTools`, `disallowedTools`, `permissionMode`, `cwd`,
  `settingSources`, `skills`, and MCP configuration to SDK options. Note that
  the SDK `tools` option controls built-in visibility only; custom tools are
  registered through `mcpServers`, not `tools`.
- Support `RuntimeSkill` by either referencing existing skill names or
  materializing PromptTrail-defined skills into a workspace `.claude/skills`
  directory when explicitly requested.
- Do not materialize skills outside the workspace without explicit approval.

Recommended API:

```ts
Agent.create()
  .user('Review this repository for risky changes')
  .claudeTurn({
    cwd: process.cwd(),
    allowedTools: ['Read', 'Glob', 'Grep'],
    skills: ['code-review'],
    settingSources: ['user', 'project'],
    capabilities: [reviewSkill],
  });
```

### OpenAI Agents SDK (deferred)

The OpenAI Agents SDK is a full agent runtime, not a thin API wrapper: it owns
its own agent loop (`Runner.run()`), runs in-process function tools and MCP
servers, and adds its own orchestration primitives — Handoffs (agent-to-agent
delegation), Guardrails (input/output validation), and Sessions (in-loop
memory).

Status: deferred. If added, it would be a runtime adapter named `agentsTurn()`,
parallel to `codexTurn()` and `claudeTurn()` — wrapping one full Agents SDK run
as a single PromptTrail turn.

Why deferred rather than prioritized:

- Unlike Codex/Claude runtimes, the Agents SDK overlaps PromptTrail's own core
  concepts: Sessions ↔ PromptTrail `Session`, Guardrails ↔ PromptTrail
  validators, Handoffs ↔ PromptTrail `subroutine()`. It is a competing
  orchestration framework, so nesting it inside PromptTrail needs a clear
  motivation (e.g. reusing an existing Agents SDK app) rather than being a
  default integration.
- The reference docs are Python (`openai-agents-python`); a PromptTrail
  integration would target the TypeScript package (`@openai/agents`), whose
  feature parity must be verified first.

When implemented, the capability mapping should follow the same rules as the
other runtime adapters: `PromptTrailTool` is a client-executed in-process
function tool, built-ins stay `runtime` mode, and Handoffs map to a
`SubagentDefinition` capability only when explicitly passed in.

### Google ADK (deferred)

Google's analog to the OpenAI Agents SDK is the Agent Development Kit (ADK,
`adk.dev`). Like the Agents SDK it is a full agent framework that owns its own
loop, with Agents, a Runner, Sessions/Memory, Graph Workflows, tools (function /
MCP / OpenAPI), multi-agent/sub-agents, and its own Skills concept. It ships a
TypeScript implementation (alongside Python/Go/Java/Kotlin) and is
**model-agnostic** (Gemini, Claude, Gemma, Ollama, vLLM, LiteLLM).

Status: deferred. If added, it would be a runtime adapter named `adkTurn()`,
parallel to `agentsTurn()`.

Why deferred — the same reasoning as the OpenAI Agents SDK, and more so:

- ADK overlaps PromptTrail's core concepts even more broadly (Sessions/Memory ↔
  `Session`, sub-agents ↔ `subroutine()`, its Skills ↔ `RuntimeSkill`). It is a
  competing orchestration framework, so nesting it needs a concrete motivation
  (reusing an existing ADK app), not a default integration.
- Because ADK is model-agnostic, it is not a way to reach Gemini — Gemini is
  reached natively through `@google/genai`. ADK would only be integrated to host
  an existing ADK agent as one PromptTrail turn.

Note the resulting symmetry: each vendor exposes a model API plus an agent
framework. PromptTrail adopts the model APIs natively (OpenAI Responses,
Anthropic Messages, Google Gemini) and the coding runtimes (`codexTurn`,
`claudeTurn`), while deferring the general agent frameworks (`agentsTurn` for the
OpenAI Agents SDK, `adkTurn` for Google ADK) because they duplicate PromptTrail's
own orchestration.

## Capability Mapping Matrix

| PromptTrail concept | OpenAI Responses                                                                | Anthropic Messages                                                                           | Codex App Server                                                   | Claude Agent SDK                                  |
| ------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `PromptTrailTool`   | function tool, PromptTrail executes                                             | tool, PromptTrail executes                                                                   | `dynamicTools`, PromptTrail executes via `item/tool/call` callback | in-process MCP tool, PromptTrail executes via SDK |
| `BuiltinTool`       | provider-hosted tool                                                            | server/provider tool                                                                         | runtime tool                                                       | runtime tool                                      |
| `RuntimeSkill`      | shell environment skill mount when shell is enabled; else instruction injection | native `container.skill_id` + code execution tool (beta headers); else instruction injection | skill input item                                                   | `.claude/skills` plus `skills` filter             |
| `McpServer`         | remote MCP tool                                                                 | MCP/server tool where supported                                                              | runtime MCP config                                                 | SDK MCP config                                    |
| `ApprovalPolicy`    | PromptTrail tool loop policy                                                    | PromptTrail tool loop policy                                                                 | runtime approval bridge                                            | SDK permission bridge                             |

## Approval Model

Approvals are a first-class runtime boundary. They must not be hidden inside
provider-specific callbacks.

```ts
export type ApprovalDecision =
  | { type: 'approve'; reason?: string }
  | { type: 'deny'; reason?: string }
  | { type: 'ask-user'; question: string };

export interface ApprovalRequest {
  provider: 'openai' | 'anthropic' | 'codex' | 'claude-agent';
  action: string;
  capability?: string;
  input?: unknown;
  risk?: 'read' | 'write' | 'network' | 'execute' | 'external';
  raw?: unknown;
}

export type ApprovalHandler = (
  request: ApprovalRequest,
  session: Session<any, any>,
) => Promise<ApprovalDecision>;
```

Model API adapters use approvals before executing PromptTrail-owned tools.
Runtime adapters use approvals when the external runtime asks for permission or
when PromptTrail is about to materialize skills, configure MCP servers, or
enable filesystem/shell tools.

## Naming

Preferred public names:

- `Capability`
- `CapabilitySet`
- `withCapabilities()`
- `PromptTrailTool`
- `RuntimeSkill`
- `BuiltinTool`
- `McpServer`
- `codexTurn()`
- `claudeTurn()`
- `agentsTurn()` (deferred; OpenAI Agents SDK runtime adapter)
- `adkTurn()` (deferred; Google ADK runtime adapter)

Avoid:

- `backend = codex_app_server` for model providers
- `Skill` as a synonym for callable tool
- Provider-specific names in common core types unless the type is explicitly
  provider-specific metadata

## Migration Plan

### Phase 1: Types and Documentation

- Add native `Capability`, `PromptTrailTool`, `RuntimeSkill`, `BuiltinTool`,
  `McpServer`, and approval types.
- Add a bidirectional adapter between ai-sdk tools and `PromptTrailTool`:
  - ai-sdk → `PromptTrailTool`: map `parameters` to `inputSchema` and wrap the
    handler, discarding/adapting the ai-sdk `ToolCallOptions` second argument in
    favor of `ToolExecutionContext`.
  - `PromptTrailTool` → ai-sdk: map `inputSchema` to `parameters` and bridge the
    `ToolExecutionContext`, so native tools keep working on the ai-sdk path.
- Keep current `Tool.create()` working (it can keep returning an ai-sdk tool
  internally while the native type is introduced).

### Phase 2: Native Responses Adapter

- Add `adapter: 'native' | 'ai-sdk'` for OpenAI.
- Implement native Responses text generation.
- Implement streaming, structured output, error mapping, and basic metadata
  retention.
- Add function tool loop.
- Preserve raw response items in message attrs.
- Keep ai-sdk as default until default parity is good. Remote MCP,
  `tool_search`, `additional_tools`, shell skills, and exact item/event
  preservation are deep-parity follow-ups, not blockers for the default switch.

### Phase 3: Native Anthropic Messages Adapter

- Add `adapter: 'native' | 'ai-sdk'` for Anthropic.
- Implement text generation, streaming, structured output, error mapping, and
  basic metadata retention.
- Implement content block preservation and tool loop.
- Preserve raw response metadata.

### Phase 3b: Native Google Gemini Adapter

- Add `adapter: 'native' | 'ai-sdk'` for Google, via the official Google GenAI
  SDK.
- Implement text generation, streaming, structured output, error mapping, and
  basic metadata retention.
- Implement function-declaration tool loop and `attrs.google` metadata.
- Keep ai-sdk as default until default parity is good.

### Phase 4: Runtime Event Common Layer

- Add inbound JSON-RPC request handling to the Codex App Server client
  (prerequisite for tools and approvals).
- Normalize Codex App Server events into `RuntimeEvent`.
- Add `onEvent` to `codexTurn()`.
- Add thread persistence helpers.

### Phase 5: Skills and Runtime Tools

- Map `PromptTrailTool` to an in-process `createSdkMcpServer()` for
  `claudeTurn()` (lower cost, no callback channel).
- Add Codex `dynamicTools` registration and `item/tool/call` handling, building
  on the Phase 4 inbound channel.
- Add the `CallToolResult` mapping and throw-to-`isError` normalization in the
  native tool layer (shared by both runtimes).
- Add Codex skill resolution and skill input items.
- Add Claude Agent SDK skill referencing.
- Add explicit skill materialization for Claude Agent SDK.
- Add native Anthropic Messages skills via `container.skill_id` + code execution
  tool + Anthropic's three API Skills beta headers, with optional `/v1/skills`
  upload behind approval.
- Add OpenAI Responses skill mounting for explicitly enabled shell environments;
  do not auto-add shell for `RuntimeSkill`. Fall back to instruction injection
  when no compatible shell/runtime capability is enabled.
- Add the instruction-injection fallback with a warn/error on dropped skill
  files for adapters without native skill support or without an enabled runtime
  that can consume skill files.

### Phase 6: Claude Runtime Adapter

- Add `claudeTurn()` as optional runtime adapter.
- Preserve SDK stream events and final answer.
- Map permissions, tools, skills, MCP, and cwd into SDK options.

### Phase 7: Cross-Cutting Generation Capabilities

Basic streaming and structured output land with each native adapter (Phases
2–3b). This phase adds the deeper, shared behavior from Generation Capabilities:

- Shared Zod → JSON Schema normalization for structured output (strict /
  nullable-optional / drop-unsupported), plus provider-specific native
  tool-loop sequencing for structured final output.
- Normalized `PromptTrailStreamEvent` reducer feeding the tool loop and the
  `retain`-aware persisted-message builder.
- Common `thinking` option, `attrs.<provider>` reasoning storage, and the
  **replay-required pin** that overrides `retain` until a turn closes or a
  binding holds the state.
- `cache` hint mapping (Anthropic breakpoints / OpenAI `prompt_cache_key` /
  Gemini `CachedContent`), with session-level `cacheKey` and sub-threshold
  no-ops.
- Multimodal `ContentPart` model, reference-not-bytes persistence, and Files API
  lifecycle/cleanup policy.
- Opt-in provider `compaction` as a binding-scoped sidecar, with stateless
  fallback replaying from canonical history.

## Open Questions

Most architectural questions have been resolved and folded into the sections
above:

- Model API / runtime split, capability taxonomy, and execution modes — Core
  Principle, Capability, Execution Modes.
- Tool delivery and execution per adapter — Tool Execution Mechanics.
- Native skill support (Anthropic) and lossy injection — Skill.
- Skill materialization strategy (no shared intermediate layer) — Skill.
- Conversation state ownership (`ConversationBinding`) — Conversation State.
- Raw-metadata volume and runtime diff/log exposure (`retain`) — Metadata
  Retention.
- Structured output, streaming, reasoning/thinking, prompt caching, multimodal
  input, and compaction across adapters — Generation Capabilities.
- When `retain` may drop reasoning/compaction artifacts (`replay-required` pin)
  — Metadata Retention, Reasoning and Thinking, Compaction.
- Default adapter selection (native on default parity, deep parity as follow-up,
  ai-sdk escape hatch) — ai-sdk Adapter.
- Scope of native adapters (OpenAI/Anthropic/Google + ai-sdk) and deferral of
  the general agent frameworks (OpenAI Agents SDK, Google ADK) — Model API
  Adapter, OpenAI Agents SDK (deferred), Google ADK (deferred).
- MCP WebSocket transport — deferred until a target provider/runtime requires
  WebSocket MCP specifically.
- `SubagentDefinition` as a core capability — deferred; keep subagents out of
  `withCapabilities()` until a runtime-specific subagent API is verified.

Remaining verification questions:

- Provider-native structured output with an active tool loop: verify OpenAI
  Responses `tools` + `text.format` sequencing and Gemini `functionCall` +
  `responseJsonSchema` behavior in adapter tests before making this a default
  native path.
- Replay-required artifacts: verify the exact stateless replay requirements for
  Anthropic signed thinking, Gemini `thoughtSignature`, OpenAI
  `encrypted_content`, and provider compaction artifacts before allowing
  `retain` to drop them.
- Provider caching: verify Gemini `CachedContent` creation constraints with
  `systemInstruction` and `tools`, and confirm the intended OpenAI
  `prompt_cache_key` mapping against current Responses behavior.

Add new questions here as they arise.
