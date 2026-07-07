# Binding Routing DSL

## Purpose

The binding DSL maps platform events to runtime routing data. It is deliberately
side-effect free: a binding decides which agent to run, which conversation to
resume, what input to append, and where replies should be delivered. The app
runtime performs checkpoint resume, outbox persistence, delivery, and presence.

## Routing As Data

A binding is a pure transform from a platform event to a normalized routing
decision. The fluent chain fills slots of a `RuntimeBinding` record:

```ts
app.on(discord.messages(), (b) =>
  b
    .to('support')
    .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
    .input((event) => event.content)
    .reply(discord.replyToOriginThread())
    .where(discord.notBot())
    .context((event) => ({ channel: event.channel })),
);
```

The calls are order-independent setters, not pipeline stages. The example above
compiles to a `RuntimeBinding` containing:

- `trigger`: the platform trigger
- `filters`: predicates from `.where(...)`
- `agent`: the selected agent name
- `conversation`: a resolver from event to conversation id
- `input`: an optional resolver from event to agent input
- `context`: optional runtime context
- `defaults`: binding-level defaults, including checkpoint and delivery

`PromptTrail.app(...).bundle()` compiles bindings into a `RuntimeBundle` IR. The
IR is inspectable, testable, and serializable in shape: tests can assert the
agent name, trigger type, defaults, and resolver behavior without starting a
Discord client or cron scheduler.

## Resolvers, Not Literals

Every event-dependent slot stores a resolver function. The runtime evaluates
those resolvers per event:

- `.conversation((event) => string)` chooses the checkpoint conversation.
- `.input((event) => string)` chooses the inbound text.
- `.context((event) => object)` adds execution context.
- `.where((event) => boolean)` admits or rejects an event.

Literal shorthand is allowed only where the type permits it, such as a fixed
input string or static binding defaults. The model stays the same: runtime
routing is data plus per-event projections.

## Platform Factories

Platform packages produce resolver shapes instead of putting platform knowledge
in core:

```ts
discord.sessionKey({ groupSessionsPerUser: true });
discord.replyToOriginThread();
discord.channel('ops');
cron.schedule('0 9 * * *');
```

Core only knows about generic `Trigger<TEvent>`, `DeliveryTarget`, and resolver
types. Discord-specific fields such as guild, channel, thread, author, and bot
mention behavior are interpreted inside `@prompttrail/discord`. Cron-specific
schedule and origin behavior lives in `@prompttrail/cron`.

## Inbound And Outbound Symmetry

Inbound and outbound routing are two projections of the same event:

- `.conversation(...)` maps the inbound event to a conversation id. That id is
  the run key used to start or resume the checkpointed conversation.
- `.reply(...)` maps the event to a delivery description. It does not send.
  Delivery is performed by the app delivery driver after assistant messages are
  persisted to the outbox.

This symmetry keeps bindings deterministic and testable. A Discord message can
route inbound state to a per-user conversation and outbound replies to the
origin thread. A cron event can route inbound state to a job-scoped
conversation and outbound replies to a configured channel or origin target.

## Mental Model

Treat the binding DSL like an HTTP router whose slots are event projections
instead of fixed path strings. `app.on(trigger, builder)` declares that events
from a trigger are eligible. The builder fills the route record: filter,
destination agent, conversation identity, input, reply target, defaults, and
context. The runtime executes the compiled route for each event.

## Runtime Boundaries

Bindings do not call model providers, write to Discord, mutate sessions, or
perform external effects. Those actions happen in agents, tools, declared
effect transforms, the checkpoint store, delivery drivers, and presence drivers.
Keeping the binding layer pure is what makes the `RuntimeBundle` useful as an
IR for tests and platform adapters.
