# Customer Support Chat

This is the flagship React integration example for PromptTrail. It uses Next.js
App Router and a durable PromptTrail app runtime.

The conversation id is the PromptTrail `runId`. The React client is stateless:
it sends `{ conversationId, message, agent }` to `/api/chat` and renders the
message list returned by the server. The server owns conversation state through
the checkpoint store, so each response is projected from
`result.session.messages`.

For this demo, durability comes from `memoryStore()`. That is enough for a
long-lived local server process, but it is not persistent across restarts and is
not suitable for serverless production. Use a persistent `DurableRunStore` in
production so checkpoints survive process replacement.

## Run

```bash
pnpm install -w
cd examples/customer-support-chat
OPENAI_API_KEY=... pnpm dev
```

The default agent source is `Source.llm()`, so the API route needs provider
credentials when you send a real chat message. Unit tests inject a mock source
and never call a provider.

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
