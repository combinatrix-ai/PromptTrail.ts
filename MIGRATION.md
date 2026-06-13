# Migration Notes

- `Agent.quick()` -> `Agent.create('name')`; node ids are optional.
- `agent(...)` factory -> `Agent.create('name')`.
- `.turn(...)` -> ordinary `inbox`, `tools`, `awaitInput`, and `loop` nodes.
- `.repeat(...)` -> `.loop(...)`.
- `.sequence(...)` -> implicit top-level or container ordering.
- `.patch(...)` -> `.transform((session) => session)` for pure sync work.
- `.messages(...)` -> `.transform(...)` plus message/session APIs.
- `kind`-based tool taxonomy -> `{ repeatable: true }` or
  `{ idempotencyKey }` effect declaration.
- Tool declarations use `effect:`; `activity:` was removed from `Tool.create`.
- Id-less `.system(source)`, `.user(source)`, and `.assistant(handler/source)`
  calls now treat the single non-string argument as content/source.
- `durable: true` / `.durable(...)` -> `checkpoint: true | store` /
  `.checkpoint(...)`.
- Top-level `store` execute option -> `checkpoint: store`.
- `RuntimeDispatchContext.channelPrompt` is no longer typed; pass custom
  context keys through the open context record.
- `Agent.execute({ checkpoint })` returns the durable run envelope
  `{ status, runId, session, awaiting? }`; non-checkpoint execute returns
  `Session`.
- `ctx.durable.*` / `onceGlobal` -> `ctx.once(name, dep, fn, { scope })`.
- `.codexTurn(...)` -> `.codex(...)`.
- `.claudeTurn(...)` -> `.claude(...)`.
- Bare `.subroutine(...)` now isolates by default; use `init` and `squash` to
  pass state through.
- `Session<TVars, TAttrs>` -> `Session<TVars>` and `Message<TAttrs>` ->
  `Message`. `withAttrsType` and `Attrs<T>` were removed; `message.attrs` is now
  an open `Readonly<Record<string, unknown>>` plumbing bag.
- Tool-result correlation moved from `message.attrs.toolCallId` to
  `message.toolCallId`. `Session.fromJSON` still revives legacy checkpoints that
  only have `attrs.toolCallId`.
- `app.bind(...)` -> `app.on(trigger, builder)`.
- `app.source(...)` -> `app.gateway(...)`.
- `app.activity(...)` -> `app.presence(...)`.
- Core Discord helpers -> `@prompttrail/discord`.
- Core cron helpers -> `@prompttrail/cron`.
- Removed authoring nodes have no compatibility shims.
