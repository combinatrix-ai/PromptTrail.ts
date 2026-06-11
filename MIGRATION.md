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
- `durable: true` / `.durable(...)` -> `checkpoint: true | store` /
  `.checkpoint(...)`.
- Top-level `store` execute option -> `checkpoint: store`.
- `ctx.durable.*` / `onceGlobal` -> `ctx.once(name, dep, fn, { scope })`.
- `.codexTurn(...)` -> `.codex(...)`.
- `.claudeTurn(...)` -> `.claude(...)`.
- Bare `.subroutine(...)` now isolates by default; use `init` and `squash` to
  pass state through.
- `app.bind(...)` -> `app.on(trigger, builder)`.
- `app.source(...)` -> `app.gateway(...)`.
- `app.activity(...)` -> `app.presence(...)`.
- Core Discord helpers -> `@prompttrail/discord`.
- Core cron helpers -> `@prompttrail/cron`.
- Removed authoring nodes have no compatibility shims.
