# Provider and Runtime Capability Integration

This document defines how PromptTrail should integrate modern model APIs and
agent runtimes without losing PromptTrail's precise template-level control.

It is intentionally a design specification, not a changelog. Code should move
toward this document in small steps.

## Source Documents

- OpenAI Responses API: https://developers.openai.com/api/reference/responses/overview
- OpenAI tools guide: https://developers.openai.com/api/docs/guides/tools
- OpenAI Agents SDK: https://openai.github.io/openai-agents-python/
- OpenAI Codex SDK: https://developers.openai.com/codex/sdk
- OpenAI Codex App Server: https://developers.openai.com/codex/app-server
- Claude Agent SDK overview: https://code.claude.com/docs/ja/agent-sdk/overview
- Claude Agent SDK custom tools: https://code.claude.com/docs/en/agent-sdk/custom-tools
- Claude Agent SDK skills: https://code.claude.com/docs/en/agent-sdk/skills
- Claude tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- Anthropic Agent Skills overview: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Anthropic Skills with the Claude API: https://platform.claude.com/docs/en/build-with-claude/skills-guide

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

Target adapters:

- OpenAI Responses API
- Anthropic Messages API
- Google Gemini API or existing ai-sdk compatibility path

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
  | McpServer
  | SubagentDefinition;
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
  execution mode), not as injected text. This requires the
  `code-execution-2025-08-25`, `skills-2025-10-02`, and `files-api-2025-04-14`
  beta headers. Pre-built skills (`pptx`, `xlsx`, `docx`, `pdf`) are referenced
  by id; custom skills must first be uploaded via the Skills API (`/v1/skills`),
  which returns a workspace-scoped id. The API container has no network access
  and no runtime package installation.
- OpenAI Responses API has no first-class skill primitive. Skills should be
  injected as instructions there (see lossy-injection note below).
- For any adapter that falls back to instruction injection, only the
  `instructions` text is conveyed; `path`, bundled files, and scripts are
  dropped. The adapter must `warn` (or `error` under a strict policy) when a
  skill carrying files/scripts is injected as text, so the loss is not silent.

### MCP Server

An MCP server is a remote or local tool namespace. PromptTrail should represent
it separately from individual tools because providers and runtimes often have
native MCP support.

```ts
export type McpTransport =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: 'ws'; url: string }
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

### Builtin Tool

A builtin tool is provider-hosted or runtime-hosted. PromptTrail configures it
but does not execute it.

Examples:

- OpenAI Responses built-ins such as web search or file search
- Claude server tools
- Codex and Claude runtime filesystem/shell tools

### Subagent

PromptTrail already has `subroutine()` for precise nested control. External
agent runtimes may also expose subagents. These should be represented as a
capability only when passed into a runtime that supports them.

## Execution Modes

Every capability must resolve to one of three execution modes.

| Mode          | Owner                                      | Examples                                          |
| ------------- | ------------------------------------------ | ------------------------------------------------- |
| `prompttrail` | PromptTrail executes and appends results   | Responses function tools, Anthropic client tools, custom tools given to Codex/Claude runtimes |
| `provider`    | Model provider executes internally         | OpenAI built-in tools, Claude server tools        |
| `runtime`     | External agent runtime executes internally | Codex shell/filesystem, Claude Code built-in tools |

This distinction is required for approval, logging, retry, and deterministic
test behavior.

Important: a `PromptTrailTool` (a custom tool with a handler) is **always**
`prompttrail` mode, including when it is passed into `codexTurn()` or
`claudeTurn()`. The runtime never executes the handler; it only decides when to
call it and then asks PromptTrail to run it. Only built-in tools (shell,
filesystem, web search) are `runtime`/`provider` mode. So the execution mode of
a custom tool is a property of the tool, not the adapter — what changes per
adapter is the *delivery path* that gets PromptTrail's handler invoked.

### Tool Execution Mechanics

The same `PromptTrailTool` reaches its handler through three different paths.
The handler runs in the PromptTrail process in all three.

| Adapter          | How the tool is registered                 | How the handler is invoked                                                                 |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Responses / Messages | function/tool definition in the request | PromptTrail's own tool loop: read `tool_use`/function call from the response, run handler, append result |
| Claude Agent SDK | `createSdkMcpServer()` + `mcpServers` option | In-process MCP server; the SDK calls the handler directly. No network hop. Result is an MCP `CallToolResult`. Pre-approve via `allowedTools: ['mcp__{server}__{tool}']` |
| Codex App Server | `dynamicTools` on `thread/start` (experimental) | Bidirectional JSON-RPC: the server sends an `item/tool/call` request back to the client; the client runs the handler and replies with content items |

Consequence for Codex: PromptTrail must act as a JSON-RPC *server* for the
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
- `message.attrs.codex` for Codex App Server turn metadata
- `message.attrs.claudeAgent` for Claude Agent SDK turn metadata

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
- Preserve output items as `attrs.openai.outputItems`.
- Support `previous_response_id` when a PromptTrail session opts into
  provider-managed conversation state.
- Support stateless mode by converting PromptTrail messages into `input` items.
- Translate `PromptTrailTool` to Responses function tools.
- Execute PromptTrail-owned function calls in a deterministic tool loop.
- Preserve built-in tool calls and provider-hosted results in raw metadata.
- Support remote MCP tools as provider-native tools when configured.
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
  headers (`code-execution-2025-08-25`, `skills-2025-10-02`,
  `files-api-2025-04-14`), rather than injecting instructions. Optionally
  support uploading a PromptTrail-defined skill through the Skills API
  (`/v1/skills`) to obtain an id, gated behind explicit approval since it
  publishes the skill workspace-wide. Account for the container's no-network /
  no-package-install constraints.

Recommended API:

```ts
Source.llm()
  .anthropic({ adapter: 'native' })
  .model('claude-sonnet-4-6')
  .withCapabilities([weatherTool]);
```

### ai-sdk Compatibility

ai-sdk is useful for broad provider compatibility and low-maintenance default
behavior. It should not be the only path for providers where PromptTrail needs
exact item, tool, reasoning, approval, or event metadata.

Policy:

- Default model calls may continue to use ai-sdk while native adapters are
  incomplete.
- Deep integration features require native adapters.
- Native adapters should expose a stable PromptTrail API, not provider SDK
  objects directly.

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

Relationship to the Codex SDK: the Codex SDK (`startThread()` / `run()` /
thread resume / sandbox policy) is a higher-level wrapper over this same
runtime — the Python SDK drives the local Codex app-server over JSON-RPC, and
custom tools / MCP / skills are configured at the app-server level, not exposed
as a separate SDK surface. So the Codex SDK adds no new capability surface over
what `codexTurn()` already targets. It is purely an implementation choice:

- Raw App Server protocol (current): no extra dependency, but PromptTrail must
  implement the inbound JSON-RPC channel itself.
- Codex SDK wrapper: less thread/turn/streaming boilerplate, at the cost of a
  pinned Codex CLI dependency.

Both reach the same `dynamicTools` / `item/tool/call` flow described above, so
the choice does not affect the capability model.

Required additions:

- **Inbound JSON-RPC request handling (prerequisite).** The current client only
  resolves outbound requests by id and handles notifications. To support custom
  tools and approvals the client must accept server-initiated requests and reply
  to them: `item/tool/call` (custom tool execution),
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  and `tool/requestUserInput`. Without this channel, only `approvalPolicy:
  'never'` and zero custom tools can work. Build this before the items below.
- `onEvent` callback for streaming runtime events.
- Stable `RuntimeEvent` normalization for item started/completed, deltas,
  command events, diffs, approvals, errors, and turn completion.
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

## Capability Mapping Matrix

| PromptTrail concept  | OpenAI Responses                                   | Anthropic Messages                                 | Codex App Server                | Claude Agent SDK                      |
| -------------------- | -------------------------------------------------- | -------------------------------------------------- | ------------------------------- | ------------------------------------- |
| `PromptTrailTool`    | function tool, PromptTrail executes                | tool, PromptTrail executes                         | `dynamicTools`, PromptTrail executes via `item/tool/call` callback | in-process MCP tool, PromptTrail executes via SDK |
| `BuiltinTool`        | provider-hosted tool                               | server/provider tool                               | runtime tool                    | runtime tool                          |
| `RuntimeSkill`       | instruction injection (no native skill primitive)  | native `container.skill_id` + code execution tool (beta headers); else instruction injection | skill input item                | `.claude/skills` plus `skills` filter |
| `McpServer`          | remote MCP tool                                    | MCP/server tool where supported                    | runtime MCP config              | SDK MCP config                        |
| `SubagentDefinition` | out of scope; use PromptTrail `subroutine()`       | out of scope; use PromptTrail `subroutine()`       | runtime subagent when supported | SDK subagent when supported           |
| `ApprovalPolicy`     | PromptTrail tool loop policy                       | PromptTrail tool loop policy                       | runtime approval bridge         | SDK permission bridge                 |

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
- Add function tool loop.
- Preserve raw response items in message attrs.
- Keep ai-sdk as default until native parity is good.

### Phase 3: Native Anthropic Messages Adapter

- Add `adapter: 'native' | 'ai-sdk'` for Anthropic.
- Implement content block preservation and tool loop.
- Preserve raw response metadata.

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
  tool + beta headers, with optional `/v1/skills` upload behind approval.
- Add the instruction-injection fallback with a warn/error on dropped skill
  files for adapters without native skill support (e.g. OpenAI Responses).

### Phase 6: Claude Runtime Adapter

- Add `claudeTurn()` as optional runtime adapter.
- Preserve SDK stream events and final answer.
- Map permissions, tools, skills, MCP, and cwd into SDK options.

## Open Questions

- Whether `Source.llm().openai()` should default to native Responses once the
  native adapter exists, or remain ai-sdk for one release.
- Whether provider-managed conversation state should be opt-in per source or per
  session.
- How much raw provider metadata should be retained by default.
- Whether skill materialization should use `.prompttrail/skills` as an
  intermediate source and then copy to runtime-specific locations.
- How to expose runtime diffs and command logs without making every assistant
  message too large.
