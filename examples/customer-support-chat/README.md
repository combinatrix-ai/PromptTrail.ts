# Customer Support Chat

This is the flagship React integration example for PromptTrail. It uses Next.js
App Router and a durable PromptTrail app runtime.

The conversation id is the PromptTrail `runId`. This demo uses one run per
agent and user: `support:<user-name>` and `returns:<user-name>`. The landing
screen asks for a name or lets you pick a saved user. Choosing a user loads both
conversation projections from the server before any new message is sent.

Durability comes from `SqliteRunStore` in `src/lib/sqlite-store.ts`, backed by
`better-sqlite3` at `.data/support.db`. The React client is stateless: it sends
`{ conversationId, message, agent }` to `/api/chat` and renders the returned
projection. The server owns conversation state through the checkpoint store.

## Run

```bash
pnpm install -w
cd examples/customer-support-chat
OPENAI_API_KEY=... pnpm dev
```

The default agent source is `Source.llm()`, so the API route needs provider
credentials when you send a real chat message. Unit tests inject a mock source
and never call a provider.

## Restart demo

1. Start the app, enter a customer name, and chat in either mode.
2. Stop the dev server.
3. Start it again.
4. Pick the same saved customer name on the landing screen.

The transcript returns because SQLite rehydrates the durable run before the app
handles any new input. The in-memory run map is still the live read model while
the server is running; SQLite is the restart substrate.

Editing agent code changes the graph manifest hash. Resuming a stored run with
different agent code throws `AgentGraphVersionError` by design, so checkpointed
conversations do not silently continue under incompatible flow code.

## SQLite schema

Each granular durable write maps directly to one table write:

| DurableRunStore method  | SQL table                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `create`                | `runs(run_id, agent_name, status, graph_cursor, graph_suspended_at, context_json, initial_session_json, graph_manifest_json)` |
| `appendSessionDelta`    | `session_deltas(run_id, seq, from_version, to_version, appended_messages_json, vars_set_json, vars_deleted_json, rewrite)`    |
| `recordOnce`            | `once_memo(run_id, scope, key, value_json)`                                                                                   |
| `appendInbox`           | `inbox(run_id, offset, kind, content, attrs_json)`                                                                            |
| `upsertOutbox`          | `outbox(run_id, idempotency_key, entry_json)`                                                                                 |
| `recordProviderSession` | `provider_sessions(run_id, node_path, binding_json)`                                                                          |
| `patch`                 | `runs` update                                                                                                                 |
| `delete`                | `runs` delete with cascading child rows                                                                                       |

Session persistence is delta based. `appendSessionDelta` inserts one
`session_deltas` row per checkpoint delta and never rewrites a full session
unless core marks the delta with `rewrite`.

## API

- `GET /api/users` returns `{ users: string[] }`, derived from stored run ids.
- `GET /api/conversation?conversationId=support:<user>` returns
  `{ status, awaiting?, messages }` without sending a message. A missing run
  returns `{ status: 'done', messages: [] }`.
- `POST /api/chat` keeps the existing
  `{ conversationId, message, agent }` request shape.

## Tool Effects

`lookupOrder` declares `effect: { repeatable: true }` because it is a read-only
lookup and can safely run again after checkpoint recovery.

`issueRefund` declares
`effect: { idempotencyKey: (input) => \`refund:${input.orderId}\` }`because it
represents a remote write. PromptTrail passes the resolved key to the tool as`ctx.idempotencyKey`, and the fake remote refund recorder stores the forwarded
key.

## Choices and server-driven UI

The return wizard demonstrates server-driven UI on top of checkpoint
suspension. A `structured` node emits a typed UI directive:

```ts
{
  reply: string;
  choices: Array<{ id: string; label: string }>;
}
```

The client renders `reply` and one button per choice from
`structuredContent`. The following `awaitInput('order-choice')` node suspends
the run and exposes its input mode through the response `awaiting` field. When
a button is clicked, the browser sends the choice `id` as the next message.
The same server-owned graph resumes, and a `conditional` branches on the
selected order id. The client owns rendering; the server owns the flow.
