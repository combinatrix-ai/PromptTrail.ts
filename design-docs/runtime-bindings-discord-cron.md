# Runtime Bindings for Discord and Cron

## Purpose

PromptTrail should support Hermes/OpenClaw-style long-running agents that are
driven by external platforms such as Discord and cron. The key API design point
is that these integrations are not just agent inputs. They are bindings between
external events, conversation identity, default sources, delivery targets,
tools, skills, and runtime context.

This document describes the target behavior before implementation. A mock
Discord connector should be the first executable acceptance test for this
design.

## Core Shape

The runtime has four user-facing layers:

- `Agent`: reusable conversation logic.
- `Bundle`: agents plus bindings, defaults, policies, and capability choices.
- `Connector`: platform integration such as Discord or cron.
- `Server`: durable runtime host that wires bundles to concrete connectors,
  store, model provider, and delivery.

The important split is:

- Agents describe how to think and respond.
- Bindings describe when an agent wakes, which conversation it belongs to, and
  which defaults apply.
- Connectors know platform-specific APIs, identifiers, filtering details, and
  delivery mechanics.
- The server owns inbox append, durable resume, locks, journaled effects, and
  delivery execution.

## Target API Sketch

This is illustrative target API, not an implementation commitment. The point is
to make the shape of the end-user configuration concrete enough that runtime
work can be judged against it.

```ts
const mainAgent = Agent.create()
  .defaults({
    user: Source.inbox(),
    assistant: Source.llm(),
    delivery: Delivery.replyToOrigin(),
  })
  .system('You are a helpful long-running assistant.')
  .loopForever((agent) =>
    agent.user().assistant().runTools().deliver().awaitNext(),
  );

const bundle = PromptTrail.runtimeBundle({
  name: 'hermes-like',

  agents: {
    main: mainAgent,
  },

  defaults: {
    durable: true,
    user: Source.inbox(),
    assistant: Source.llm().openai({ model: 'gpt-5.5' }),
    delivery: Delivery.replyToOrigin(),
  },

  bindings: [
    bind(discord.messages())
      .where(discord.notBot())
      .where(discord.inChannels(['general', 'oracle_cloud', 'news']))
      .toAgent('main')
      .conversation(
        discord.sessionKey({
          groupSessionsPerUser: true,
          threadSessionsPerUser: false,
        }),
      )
      .defaults({
        delivery: discord.replyToThread(),
        toolsets: [
          'browser',
          'clarify',
          'code_execution',
          'cronjob',
          'delegation',
          'discord',
          'discord_admin',
          'file',
          'image_gen',
          'kanban',
          'memory',
          'messaging',
          'session_search',
          'skills',
          'terminal',
          'todo',
          'tts',
          'vision',
          'web',
        ],
        context: {
          historyBackfill: { enabled: true, limit: 50 },
          channelPrompt: discord.channelPrompt(),
        },
        behavior: {
          requireMention: false,
          autoThread: true,
          threadRequireMention: false,
          reactions: true,
          maxAttachmentBytes: 33_554_432,
        },
      }),

    bind(cron.schedule('every 360m'))
      .name('HN top100 digest')
      .toAgent('main')
      .conversation(({ job }) => `cron:${job.id}`)
      .input(hnDigestPrompt)
      .defaults({
        delivery: discord.channel('news'),
        toolsets: ['web', 'terminal', 'delegation'],
      }),

    bind(cron.schedule('0 20 * * *'))
      .name('Semi supplier earnings calendar daily update')
      .toAgent('main')
      .conversation(({ job }) => `cron:${job.id}`)
      .input(semiSupplierPrompt)
      .defaults({
        delivery: Delivery.origin(),
        skills: ['japan-semi-supplier-research', 'api-change-watchers'],
        toolsets: ['terminal', 'file', 'web'],
        workdir: '/home/ubuntu/obsidian/Work/semi-companies',
      }),
  ],
});

const server = PromptTrail.server({
  store: sqliteStore('./prompttrail.db'),
  connectors: {
    discord: Discord.connect({ token: process.env.DISCORD_TOKEN! }),
    cron: Cron.connect(),
  },
});

server.use(bundle);
await server.start();
```

## Equivalent Hermes-Like Scenario

This section describes a fictional setup equivalent to a real Hermes-style
gateway configuration. Names and IDs are intentionally fake.

The user has one Discord server, `workroom`, with three channels:

- `#general`: normal conversation with the bot.
- `#cloud-lab`: infrastructure/debugging discussions.
- `#news`: proactive digests and scheduled reports.

Desired Discord behavior:

- The bot listens only in those three channels.
- It does not require mentions in those channels.
- It ignores bot-authored messages.
- If a user talks in a parent channel, the runtime may create or bind a thread
  so the durable conversation is isolated.
- Once inside a thread, follow-up messages from any participant continue the
  same durable conversation.
- Ordinary parent-channel conversations remain per-user so Alice and Bob do not
  share context by accident.
- The bot can use Discord tools and general research/coding tools in Discord
  sessions.
- Channel-specific prompt/skill overrides are available, even if this example
  leaves them empty.

Desired scheduled jobs:

- `HN top100 digest`: runs every 6 hours, uses web/terminal/delegation tools,
  and posts to `#news`.
- `Supplier earnings calendar`: runs every day at 20:00, uses specialized
  research skills, runs with an Obsidian workdir, and posts back to the Discord
  thread where the job was created.

As a config-shaped sketch:

```ts
const workroom = PromptTrail.runtimeBundle({
  name: 'workroom-assistant',

  agents: {
    main: mainAgent,
  },

  bindings: [
    bind(discord.messages())
      .where(discord.notBot())
      .where(discord.inChannels(['general', 'cloud-lab', 'news']))
      .toAgent('main')
      .conversation(
        discord.sessionKey({
          groupSessionsPerUser: true,
          threadSessionsPerUser: false,
        }),
      )
      .defaults({
        delivery: discord.replyToOriginThread(),
        toolsets: [
          'web',
          'terminal',
          'file',
          'memory',
          'discord',
          'discord_admin',
          'cronjob',
          'skills',
          'delegation',
        ],
        context: {
          historyBackfill: { enabled: true, limit: 50 },
          channelPrompts: {
            // 'cloud-lab': 'You are operating in infrastructure debug mode.',
            // 'news': 'Keep proactive digest posts concise and source-backed.',
          },
          channelSkillBindings: [
            // { channel: 'cloud-lab', skills: ['cloud-ops-debugging'] },
          ],
        },
        behavior: {
          allowedChannels: ['general', 'cloud-lab', 'news'],
          freeResponseChannels: ['general', 'cloud-lab', 'news'],
          threadResponseChannels: ['general', 'cloud-lab', 'news'],
          requireMention: false,
          autoThread: true,
          threadRequireMention: false,
          reactions: true,
          allowAnyAttachment: false,
          maxAttachmentBytes: 33_554_432,
        },
      }),

    bind(cron.schedule('every 360m'))
      .name('HN top100 digest')
      .toAgent('main')
      .conversation(({ job }) => `cron:${job.id}`)
      .input(
        ({ scriptOutput }) => `
        You are running an automated Hacker News digest for #news.
        Use the fetched top 100 stories below. Pick the items that matter,
        read article/comment context when useful, and produce a concise digest.

        ${scriptOutput}
      `,
      )
      .defaults({
        delivery: discord.channel('news'),
        toolsets: ['web', 'terminal', 'delegation'],
      }),

    bind(cron.schedule('0 20 * * *'))
      .name('Supplier earnings calendar daily update')
      .toAgent('main')
      .conversation(({ job }) => `cron:${job.id}`)
      .input(
        `
        Maintain the user's supplier earnings calendar.
        Check for newly announced earnings dates and update the research note.
        If nothing changed, say so briefly.
      `,
      )
      .defaults({
        delivery: Delivery.origin(),
        skills: ['supplier-research', 'api-change-watchers'],
        toolsets: ['terminal', 'file', 'web'],
        workdir: '/home/user/notes/Work/suppliers',
      }),
  ],
});
```

The same scenario can also be expressed as a more data-oriented runtime bundle.
This is useful for tests, mocks, generated runtime wiring, or deployment code:

```ts
const workroom = PromptTrail.runtimeBundle({
  name: 'workroom-assistant',

  agents: { main: mainAgent },

  discord: {
    messages: {
      agent: 'main',
      allowedChannels: ['general', 'cloud-lab', 'news'],
      freeResponseChannels: ['general', 'cloud-lab', 'news'],
      threadResponseChannels: ['general', 'cloud-lab', 'news'],
      requireMention: false,
      autoThread: true,
      threadRequireMention: false,
      groupSessionsPerUser: true,
      threadSessionsPerUser: false,
      historyBackfill: { enabled: true, limit: 50 },
      reactions: true,
      toolsets: [
        'web',
        'terminal',
        'file',
        'memory',
        'discord',
        'discord_admin',
        'cronjob',
        'skills',
        'delegation',
      ],
    },
  },

  cron: {
    jobs: [
      {
        name: 'HN top100 digest',
        schedule: 'every 360m',
        agent: 'main',
        input: hnDigestPrompt,
        delivery: discord.channel('news'),
        toolsets: ['web', 'terminal', 'delegation'],
      },
      {
        name: 'Supplier earnings calendar daily update',
        schedule: '0 20 * * *',
        agent: 'main',
        input: supplierCalendarPrompt,
        delivery: Delivery.origin(),
        skills: ['supplier-research', 'api-change-watchers'],
        toolsets: ['terminal', 'file', 'web'],
        workdir: '/home/user/notes/Work/suppliers',
      },
    ],
  },
});
```

The fluent form is better for TypeScript composition. The data form is better
for config loading and UI. Both should compile into the same binding model.

## Defaults

There are three kinds of defaults. They should not be collapsed into one API.

### Agent Defaults

Agent defaults make template authoring concise:

```ts
Agent.create()
  .defaults({
    user: Source.inbox(),
    assistant: Source.llm(),
    delivery: Delivery.replyToOrigin(),
  })
  .loopForever((agent) => agent.user().assistant().deliver());
```

They answer: "when this agent says `user()` or `assistant()` with no argument,
what source should be used?"

### Binding Defaults

Binding defaults are applied when a source event starts or resumes a durable
conversation. They answer: "for this Discord route or cron schedule, what
agent, delivery, tools, skills, workdir, model, and context should be active?"

Examples:

- Discord channel messages get Discord-specific tools and reply delivery.
- A cron digest gets only `web`, `terminal`, and `delegation` tools.
- A specialized cron job gets extra skills and an Obsidian workdir.

### Connector Defaults

Connector defaults are platform implementation details:

- Discord token and client options.
- Home channel for proactive delivery.
- How to send a message to a thread.
- How to recover history backfill.
- How to cache attachments.
- How to set reactions or typing indicators.

Connector defaults should not leak into agent definitions except through typed
binding helpers such as `discord.replyToThread()` or
`discord.sessionKey(...)`.

## Runtime Event Model

Every connector should normalize platform events into a runtime envelope:

```ts
type RuntimeEvent = {
  source: string;
  agent: string;
  conversationId: string;
  input: string;
  kind?: 'user' | 'system' | 'control';
  durable?: boolean;
  attrs?: Record<string, unknown>;
  defaults?: BindingDefaults;
  delivery?: DeliveryTarget;
};
```

`conversationId` is the durable run key. `runId` may remain the internal name,
but the public API should prefer `conversationId` for platform agents.

## Discord Behavior

Discord bindings should support the behavior used by a real Hermes-style
gateway:

- Allow only configured channels when `allowedChannels` is set.
- Ignore configured channels when `ignoredChannels` is set.
- If `requireMention` is false, messages in allowed/free-response channels
  wake the agent without a mention.
- If `requireMention` is true, only mentions wake the agent except in free
  response channels or threads where the bot is already participating.
- If `autoThread` is true, a message in a parent channel can create or bind to a
  thread before routing, so the conversation is isolated.
- If `threadRequireMention` is false, follow-up messages inside active threads
  continue the same conversation without mentioning the bot.
- `historyBackfill` can prepend recent channel/thread context to the current
  input without permanently changing the platform transcript.
- `channelPrompts` and `channelSkillBindings` are resolved by channel id first,
  then parent channel id for threads.
- Reactions and typing/progress updates are connector behaviors, not LLM tools.

## Conversation Identity

The identity strategy must be explicit because it controls durable session
sharing.

Target Discord default:

```ts
discord.sessionKey({
  groupSessionsPerUser: true,
  threadSessionsPerUser: false,
});
```

Expected keys:

| Source          | Default conversation behavior                       |
| --------------- | --------------------------------------------------- |
| Discord DM      | one conversation per DM user/chat                   |
| Discord channel | one conversation per user in that channel           |
| Discord thread  | one shared conversation for all thread participants |
| Cron job        | one conversation per scheduled job/run identity     |

This mirrors the useful Hermes behavior: normal shared channels avoid context
pollution between users, but threads become a shared room brain.

Examples:

```ts
discord:dm:U1
discord:guild:G1:channel:C1:user:U1
discord:guild:G1:thread:T1
cron:hn-digest:job-123
```

## Delivery

Delivery is separate from tools.

```ts
.deliver(discord.replyToThread())
```

is deterministic runtime delivery of the assistant's final output. It is not a
model-callable `sendMessage` tool.

Model-callable Discord actions are a separate capability subset:

```ts
Source.llm().withTools(
  discord.tools({
    allow: ['fetchThread', 'createThread', 'addReaction'],
  }),
);
```

Effectful actions and delivery must be journaled with idempotency keys so replay
does not double-post.

## Cron Behavior

Cron bindings are source events with scheduled inputs. A cron binding can
choose:

- schedule expression
- prompt/input
- target agent
- conversation identity
- delivery target
- origin delivery
- toolsets
- skills
- workdir
- model/provider override
- no-agent script-only mode later

`Delivery.origin()` means: deliver back to the platform/thread that created the
job, if the job has an origin. If no origin exists, fall back to local logging
or an explicit home channel.

Cron runs should use fresh or job-scoped durable conversations by default. They
should not accidentally append outputs to an unrelated user chat transcript.

## Mock Discord Acceptance Test

The first implementation target should be a mock connector, not real
`discord.js`.

The mock should expose:

```ts
const discord = mockDiscord({
  channels: {
    general: { id: 'C_general' },
    oracle_cloud: { id: 'C_oracle' },
    news: { id: 'C_news' },
  },
});

discord.receive({
  channel: 'oracle_cloud',
  author: 'alice',
  content: 'login failed',
});

discord.receive({
  channel: 'oracle_cloud',
  thread: 'T_login',
  author: 'bob',
  content: 'same issue here',
});

expect(discord.deliveries()).toEqual([...]);
```

## Test Scenario Fixture

All scenarios below assume this fictional bundle:

```ts
const fixture = mockRuntimeFixture({
  channels: {
    general: { id: 'C_general', name: 'general' },
    cloudLab: { id: 'C_cloud', name: 'cloud-lab' },
    news: { id: 'C_news', name: 'news' },
    random: { id: 'C_random', name: 'random' },
  },

  users: {
    alice: { id: 'U_alice', name: 'Alice' },
    bob: { id: 'U_bob', name: 'Bob' },
    digestBot: { id: 'U_digest_bot', name: 'DigestBot', bot: true },
  },

  bindings: workroom.bindings,

  // Deterministic assistant for tests. It should echo the binding context so
  // tests can assert routing/defaults without calling a real model.
  assistant: ({ input, context }) => ({
    content: `reply:${input.latestText}`,
    observed: {
      conversationId: context.conversationId,
      delivery: context.delivery,
      toolsets: context.toolsets,
      skills: context.skills,
      workdir: context.workdir,
      channelPrompt: context.channelPrompt,
    },
  }),
});
```

The mock runtime should expose inspectable state:

```ts
fixture.runtime.conversations();
fixture.runtime.inbox(conversationId);
fixture.runtime.session(conversationId);
fixture.discord.deliveries();
fixture.discord.threads();
fixture.cron.runs();
fixture.effects.journal();
```

These names are illustrative. The important requirement is that tests can
observe normalized events, conversation identity, binding defaults, and
deliveries without using a real Discord API.

## Discord Admission Scenarios

### D1. Allowed free-response channel wakes without mention

Input:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  author: 'alice',
  content: 'why is the VM out of disk?',
  mentionsBot: false,
});
```

Expected:

- One normalized runtime event is emitted.
- `agent` is `main`.
- `conversationId` is
  `discord:guild:workroom:channel:C_cloud:user:U_alice`.
- The input is appended to that conversation inbox.
- The assistant runs once.
- One delivery is sent back to `cloud-lab` or to an auto-created thread,
  depending on the active `autoThread` policy.

### D2. Bot-authored messages are dropped

Input:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  author: 'digestBot',
  content: 'automated status',
});
```

Expected:

- No runtime event is emitted.
- No conversation is created.
- No assistant run occurs.
- No delivery is sent.

### D3. Disallowed channel is dropped

Input:

```ts
await fixture.discord.receive({
  channel: 'random',
  author: 'alice',
  content: 'hello from elsewhere',
});
```

Expected:

- No runtime event is emitted because `random` is not in
  `allowedChannels`.
- No delivery is sent, even though `requireMention` is false elsewhere.

### D4. Mention-gated variant only wakes on mention

Given a variant binding:

```ts
behavior: {
  allowedChannels: ['cloud-lab'],
  requireMention: true,
  freeResponseChannels: [],
}
```

Inputs:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  author: 'alice',
  content: 'quiet background message',
  mentionsBot: false,
});

await fixture.discord.receive({
  channel: 'cloud-lab',
  author: 'alice',
  content: '@bot please inspect this',
  mentionsBot: true,
});
```

Expected:

- The first message is dropped.
- The second message wakes `main`.
- The model-visible input has the bot mention stripped if the connector
  supports mention stripping.

## Discord Conversation Identity Scenarios

### C1. Parent-channel sessions are isolated per user

Inputs:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  author: 'alice',
  content: 'alice task',
  autoThread: false,
});

await fixture.discord.receive({
  channel: 'cloud-lab',
  author: 'bob',
  content: 'bob task',
  autoThread: false,
});
```

Expected:

- Alice uses
  `discord:guild:workroom:channel:C_cloud:user:U_alice`.
- Bob uses
  `discord:guild:workroom:channel:C_cloud:user:U_bob`.
- The two sessions do not share messages or pending work.

### C2. Threads are shared across users by default

Inputs:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  thread: 'T_incident',
  author: 'alice',
  content: 'the deploy failed',
});

await fixture.discord.receive({
  channel: 'cloud-lab',
  thread: 'T_incident',
  author: 'bob',
  content: 'I see the same failure',
});
```

Expected:

- Both messages use `discord:guild:workroom:thread:T_incident`.
- The second input resumes the existing durable conversation.
- The session transcript includes both Alice and Bob messages.
- The delivery target remains thread `T_incident`.

### C3. Thread per-user isolation can be opted in

Given `threadSessionsPerUser: true`, use the same inputs as C2.

Expected:

- Alice uses `discord:guild:workroom:thread:T_incident:user:U_alice`.
- Bob uses `discord:guild:workroom:thread:T_incident:user:U_bob`.
- The two users no longer share thread context.

### C4. Auto-thread binds parent-channel trigger to a new thread

Input:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  author: 'alice',
  content: 'debug this disk issue',
  mentionsBot: false,
});
```

Expected when `autoThread: true`:

- The mock Discord connector records one created thread under `cloud-lab`.
- The runtime event uses the created thread id as the conversation id.
- The delivery goes to the created thread, not the parent channel.
- Follow-up messages in that thread resume the same durable conversation.

## Binding Defaults Scenarios

### B1. Discord binding defaults reach the agent context

Input:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  thread: 'T_debug',
  author: 'alice',
  content: 'inspect the latest logs',
});
```

Expected agent context:

```ts
{
  agent: 'main',
  durable: true,
  delivery: { platform: 'discord', channel: 'cloud-lab', thread: 'T_debug' },
  toolsets: [
    'web',
    'terminal',
    'file',
    'memory',
    'discord',
    'discord_admin',
    'cronjob',
    'skills',
    'delegation',
  ],
  historyBackfill: { enabled: true, limit: 50 },
}
```

The exact object shape can change, but these effective values must be
observable.

### B2. Channel prompt resolves by thread first, then parent

Given:

```ts
channelPrompts: {
  cloudLab: 'Infrastructure debug mode.',
  T_special: 'Incident commander mode.',
}
```

Inputs:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  thread: 'T_regular',
  author: 'alice',
  content: 'regular thread',
});

await fixture.discord.receive({
  channel: 'cloud-lab',
  thread: 'T_special',
  author: 'alice',
  content: 'special thread',
});
```

Expected:

- `T_regular` receives `Infrastructure debug mode.` from the parent channel.
- `T_special` receives `Incident commander mode.` from the exact thread.
- The prompt is ephemeral runtime context, not a persisted user message.

### B3. Channel skill binding resolves like channel prompt

Given:

```ts
channelSkillBindings: [
  { channel: 'cloud-lab', skills: ['cloud-ops-debugging'] },
  { channel: 'T_special', skills: ['incident-review'] },
];
```

Expected:

- Regular `cloud-lab` threads receive `['cloud-ops-debugging']`.
- `T_special` receives `['incident-review']`.
- These skills are active for that turn and visible in the binding context.

## Delivery Scenarios

### O1. Assistant reply is delivered to origin thread

Input:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  thread: 'T_debug',
  author: 'alice',
  content: 'status?',
});
```

Expected delivery:

```ts
{
  platform: 'discord',
  channel: 'cloud-lab',
  thread: 'T_debug',
  content: 'reply:status?',
}
```

### O2. Delivery is not exposed as a model-callable send tool

Expected:

- The assistant can produce a normal final message and runtime delivery sends
  it.
- The model-callable tool list does not need to include `sendMessage` for basic
  replies.
- If a `discord.sendMessage` tool is explicitly enabled, it is treated as an
  effectful action and journaled separately from final delivery.

### O3. Durable replay does not double-deliver

Flow:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  thread: 'T_debug',
  author: 'alice',
  content: 'first',
});

await fixture.runtime.resume('discord:guild:workroom:thread:T_debug');
```

Expected:

- The assistant's deterministic reply is delivered once.
- Replay reads delivery from the journal or idempotency record.
- `fixture.discord.deliveries()` still has one item for the first turn.

## Cron Scenarios

### K1. Cron digest posts to explicit Discord channel

Trigger:

```ts
await fixture.cron.tick('HN top100 digest', {
  scriptOutput: '1. Example story\\n2. Another story',
});
```

Expected:

- The runtime starts or resumes `cron:<hn-job-id>`.
- The active toolsets are `['web', 'terminal', 'delegation']`.
- The delivery target is Discord `#news`.
- The delivery does not use the Discord thread that created some unrelated job.

### K2. Cron origin delivery posts back to stored origin thread

Given a cron job created from a Discord thread:

```ts
origin: {
  platform: 'discord',
  channel: 'cloud-lab',
  thread: 'T_supplier_research',
}
```

Trigger:

```ts
await fixture.cron.tick('Supplier earnings calendar daily update');
```

Expected:

- The runtime starts or resumes `cron:<supplier-job-id>`.
- The active skills are `['supplier-research', 'api-change-watchers']`.
- The active toolsets are `['terminal', 'file', 'web']`.
- The active workdir is `/home/user/notes/Work/suppliers`.
- The delivery target is Discord thread `T_supplier_research`.

### K3. Cron origin fallback when origin is missing

Given a cron job with `delivery: Delivery.origin()` and no origin:

Expected:

- The job still runs.
- Output is logged locally or delivered to a configured home channel,
  depending on server defaults.
- The runtime records that origin delivery was unresolved.

## Busy Conversation Scenarios

### Q1. Follow-up text while a conversation is active is queued or interrupts

Flow:

```ts
await fixture.discord.receive({
  channel: 'cloud-lab',
  thread: 'T_debug',
  author: 'alice',
  content: 'long task',
});

await fixture.discord.receive({
  channel: 'cloud-lab',
  thread: 'T_debug',
  author: 'bob',
  content: 'additional detail',
});
```

Expected:

- Only one active runner owns `discord:guild:workroom:thread:T_debug`.
- The second message is not dropped.
- Depending on the configured busy policy, it is queued for the next turn or
  interrupts the active turn.
- No duplicate assistant runs execute concurrently for the same conversation.

## Ideal API Scenario Tests

This section is intentionally written like tests, but it is still design
documentation. The goal is to make the final API feel concrete before building
the runtime implementation.

The tests should read as "a user can define a Hermes-like app, attach mock
Discord and mock cron, then inspect routing, durable identity, defaults, and
delivery."

### T1. A Hermes-like app can be declared in one place

```ts
describe('PromptTrail runtime bindings target API', () => {
  const mainAgent = Agent.create()
    .defaults({
      user: Source.inbox(),
      assistant: Source.llm(),
      delivery: Delivery.replyToOrigin(),
    })
    .system('You are a durable workroom assistant.')
    .loopForever((agent) => agent.user().assistant().deliver().awaitNext());

  const workroom = PromptTrail.runtimeBundle({
    name: 'workroom-assistant',

    agents: {
      main: mainAgent,
    },

    defaults: {
      durable: true,
    },

    bindings: [
      bind(discord.messages())
        .where(discord.notBot())
        .where(discord.inChannels(['general', 'cloud-lab', 'news']))
        .toAgent('main')
        .conversation(
          discord.sessionKey({
            groupSessionsPerUser: true,
            threadSessionsPerUser: false,
          }),
        )
        .defaults({
          delivery: discord.replyToOriginThread(),
          toolsets: [
            'web',
            'terminal',
            'file',
            'memory',
            'discord',
            'discord_admin',
            'cronjob',
            'skills',
            'delegation',
          ],
          context: {
            historyBackfill: { enabled: true, limit: 50 },
          },
          behavior: {
            allowedChannels: ['general', 'cloud-lab', 'news'],
            freeResponseChannels: ['general', 'cloud-lab', 'news'],
            threadResponseChannels: ['general', 'cloud-lab', 'news'],
            requireMention: false,
            autoThread: true,
            threadRequireMention: false,
            reactions: true,
            allowAnyAttachment: false,
            maxAttachmentBytes: 33_554_432,
          },
        }),

      bind(cron.schedule('every 360m'))
        .name('HN top100 digest')
        .toAgent('main')
        .conversation(({ job }) => `cron:${job.id}`)
        .input(hnDigestPrompt)
        .defaults({
          delivery: discord.channel('news'),
          toolsets: ['web', 'terminal', 'delegation'],
        }),

      bind(cron.schedule('0 20 * * *'))
        .name('Supplier earnings calendar daily update')
        .toAgent('main')
        .conversation(({ job }) => `cron:${job.id}`)
        .input(supplierCalendarPrompt)
        .defaults({
          delivery: Delivery.origin(),
          skills: ['supplier-research', 'api-change-watchers'],
          toolsets: ['terminal', 'file', 'web'],
          workdir: '/home/user/notes/Work/suppliers',
        }),
    ],
  });

  const fixture = mockRuntimeFixture({
    bundle: workroom,
    connectors: {
      discord: mockDiscord({
        guild: 'workroom',
        channels: {
          general: { id: 'C_general', name: 'general' },
          cloudLab: { id: 'C_cloud', name: 'cloud-lab' },
          news: { id: 'C_news', name: 'news' },
          random: { id: 'C_random', name: 'random' },
        },
      }),
      cron: mockCron(),
    },
    assistant: deterministicAssistant(),
  });
});
```

Expected:

- The app definition contains agent logic, Discord bindings, and cron bindings
  without requiring a real server or real Discord client.
- The same bundle can later be installed into `PromptTrail.server(...)`.
- Tests can replace connectors and model providers with deterministic mocks.

### T2. Discord messages route into durable agent conversations

```ts
it('routes an allowed Discord message to the durable agent', async () => {
  await fixture.discord.receive({
    channel: 'cloud-lab',
    author: 'alice',
    content: 'why is the VM out of disk?',
    mentionsBot: false,
  });

  expect(fixture.runtime.conversations()).toContainEqual({
    id: 'discord:guild:workroom:channel:C_cloud:user:U_alice',
    agent: 'main',
    status: 'suspended',
  });

  expect(
    fixture.runtime.inbox(
      'discord:guild:workroom:channel:C_cloud:user:U_alice',
    ),
  ).toContainEqual({
    role: 'user',
    source: 'discord',
    content: 'why is the VM out of disk?',
  });

  expect(fixture.discord.deliveries()).toContainEqual({
    channel: 'cloud-lab',
    content: 'reply:why is the VM out of disk?',
  });
});
```

This is the most important baseline: external input becomes inbox input,
`Source.inbox()` feeds `user()`, `assistant()` runs, delivery happens, and the
conversation suspends waiting for the next external event.

### T3. Parent-channel conversations are per-user, threads are shared

```ts
it('keeps parent-channel users isolated', async () => {
  await fixture.discord.receive({
    channel: 'cloud-lab',
    author: 'alice',
    content: 'alice task',
    autoThread: false,
  });

  await fixture.discord.receive({
    channel: 'cloud-lab',
    author: 'bob',
    content: 'bob task',
    autoThread: false,
  });

  expect(fixture.runtime.conversations()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'discord:guild:workroom:channel:C_cloud:user:U_alice',
      }),
      expect.objectContaining({
        id: 'discord:guild:workroom:channel:C_cloud:user:U_bob',
      }),
    ]),
  );
});

it('shares a thread conversation across participants by default', async () => {
  await fixture.discord.receive({
    channel: 'cloud-lab',
    thread: 'T_incident',
    author: 'alice',
    content: 'the deploy failed',
  });

  await fixture.discord.receive({
    channel: 'cloud-lab',
    thread: 'T_incident',
    author: 'bob',
    content: 'I see the same failure',
  });

  expect(
    fixture.runtime.inbox('discord:guild:workroom:thread:T_incident'),
  ).toEqual([
    expect.objectContaining({ author: 'alice' }),
    expect.objectContaining({ author: 'bob' }),
  ]);
});
```

This pins down the desired Hermes-like identity rule: parent channels avoid
accidental context sharing, while threads are durable shared rooms.

### T4. Binding defaults are visible to agent execution

```ts
it('passes Discord binding defaults to the agent context', async () => {
  await fixture.discord.receive({
    channel: 'cloud-lab',
    thread: 'T_debug',
    author: 'alice',
    content: 'inspect logs',
  });

  expect(fixture.runtime.lastAssistantObservation()).toMatchObject({
    conversationId: 'discord:guild:workroom:thread:T_debug',
    delivery: {
      platform: 'discord',
      channel: 'cloud-lab',
      thread: 'T_debug',
    },
    toolsets: [
      'web',
      'terminal',
      'file',
      'memory',
      'discord',
      'discord_admin',
      'cronjob',
      'skills',
      'delegation',
    ],
    historyBackfill: { enabled: true, limit: 50 },
  });
});
```

The assertion is not about exact internal object names. It is about the
effective context available to sources, tools, skills, model selection, and
delivery.

### T5. Cron jobs use the same binding mechanism as Discord

```ts
it('runs a scheduled digest and delivers it to #news', async () => {
  await fixture.cron.tick('HN top100 digest', {
    scriptOutput: '1. Example story\n2. Another story',
  });

  expect(fixture.runtime.conversations()).toContainEqual(
    expect.objectContaining({
      id: 'cron:hn-top100-digest',
      agent: 'main',
    }),
  );

  expect(fixture.runtime.lastAssistantObservation()).toMatchObject({
    toolsets: ['web', 'terminal', 'delegation'],
    delivery: {
      platform: 'discord',
      channel: 'news',
    },
  });

  expect(fixture.discord.deliveries()).toContainEqual({
    channel: 'news',
    content: expect.stringContaining('reply:'),
  });
});

it('delivers an origin-based cron job to the stored Discord thread', async () => {
  fixture.cron.setOrigin('Supplier earnings calendar daily update', {
    platform: 'discord',
    channel: 'cloud-lab',
    thread: 'T_supplier_research',
  });

  await fixture.cron.tick('Supplier earnings calendar daily update');

  expect(fixture.runtime.lastAssistantObservation()).toMatchObject({
    skills: ['supplier-research', 'api-change-watchers'],
    toolsets: ['terminal', 'file', 'web'],
    workdir: '/home/user/notes/Work/suppliers',
    delivery: {
      platform: 'discord',
      channel: 'cloud-lab',
      thread: 'T_supplier_research',
    },
  });
});
```

Cron is not a special side system. It is another event source that produces an
input, resolves a conversation id, applies defaults, and resumes the agent.

### T6. Mock effects are idempotent across durable resume

```ts
it('does not double-deliver when a durable conversation is resumed', async () => {
  await fixture.discord.receive({
    channel: 'cloud-lab',
    thread: 'T_debug',
    author: 'alice',
    content: 'first',
  });

  await fixture.runtime.resume('discord:guild:workroom:thread:T_debug');

  expect(fixture.discord.deliveries()).toEqual([
    expect.objectContaining({
      channel: 'cloud-lab',
      thread: 'T_debug',
      content: 'reply:first',
    }),
  ]);

  expect(fixture.effects.journal()).toContainEqual(
    expect.objectContaining({
      kind: 'delivery',
      idempotencyKey:
        'discord:guild:workroom:thread:T_debug:turn:1:delivery:final',
      status: 'completed',
    }),
  );
});
```

This test is the durable boundary. Model/tool execution can be replayed or
resumed, but externally visible effects must be journaled and idempotent.

## Implementation Notes

The current durable prototype already has `PromptTrail.app`, `EventSource`,
`InboundRuntimeEvent`, `memoryStore`, and a basic `agent().turn(...)` API. That
prototype is enough to prove routing, inbox append, and replay. It is not yet
enough for the full target behavior.

Needed runtime additions:

- Public `conversationId` alias for durable `runId`.
- A `Binding` abstraction that resolves source events into runtime events plus
  defaults.
- `Source.inbox()` for normal `user()` authoring.
- `Delivery` abstraction and runtime-managed delivery step.
- Long-running chat turn semantics: consume current inbox, respond, deliver,
  then suspend without completing the run.
- Per-conversation locking and pending-message queuing.
- Journaled delivery/effects with idempotency keys.
- Mock Discord connector and acceptance tests.

The mock connector should be the proving ground before implementing real
Discord. Real Discord can then be an adapter over the same binding and delivery
contracts.
