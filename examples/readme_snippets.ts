/**
 * Mirrors the code blocks in the repository README so they stay
 * typechecked. If you edit a README example, update it here too (and vice
 * versa); `pnpm -C examples typecheck` guards both.
 *
 * Externals that the README references but does not define are declared as
 * ambient functions below. Nothing in this file is executed.
 */
import {
  Agent,
  PromptTrail,
  Session,
  Source,
  Tool,
  memoryStore,
  type Vars,
} from '@prompttrail/core';
import { discord, discordGateway } from '@prompttrail/discord';
import { z } from 'zod';

declare function searchDocumentation(q: string): Promise<string[]>;
declare function chargeRemoteSystem(x: unknown): Promise<unknown>;
declare function fetchProfile(id: unknown): Promise<unknown>;

// --- Quick Start ---------------------------------------------------------

const quickStart = Agent.create('support')
  .system('You are a concise support assistant.')
  .user('How do I reset my password?')
  .assistant(Source.llm().openai({ modelName: 'gpt-5.4-nano' }));

const quickSession = await quickStart.execute();
console.log(quickSession.getLastMessage()?.content);

const inboxAssistant = Agent.create('support-inbox')
  .system('Answer the latest inbound user message.')
  .inbox()
  .assistant(Source.llm());

await inboxAssistant.execute({
  input: 'What is the status of my order?',
});

// --- Sessions ------------------------------------------------------------

const typedSession = Session.create<Vars<{ userId: string }>>({
  vars: { userId: 'u-1' },
});
const nextSession = typedSession.withVar('plan', 'pro');
nextSession.getVar('userId') satisfies string;

// --- Agent Authoring -----------------------------------------------------

const triageAnonymous = Agent.create('triage')
  .system('Classify the request and ask one clarifying question if needed.')
  .inbox()
  .assistant(Source.llm());
void triageAnonymous;

const triageAuthored = Agent.create('triage-authored')
  .system('policy', 'Use the current support policy.')
  .inbox('customer-message')
  .assistant('draft', Source.llm());
void triageAuthored;

// --- Tools and Effects ---------------------------------------------------

const searchDocs = Tool.create({
  name: 'searchDocs',
  description: 'Search documentation.',
  inputSchema: z.object({ query: z.string() }),
  effect: { repeatable: true },
  execute: async ({ query }) => searchDocumentation(query),
});

const chargeCard = Tool.create({
  name: 'chargeCard',
  description: 'Charge a card for an order.',
  inputSchema: z.object({ orderId: z.string(), cents: z.number() }),
  effect: {
    idempotencyKey: (input) =>
      `charge:${(input as { orderId: string }).orderId}`,
  },
  execute: async ({ orderId, cents }, ctx) =>
    chargeRemoteSystem({ orderId, cents, idempotencyKey: ctx.idempotencyKey }),
});
void chargeCard;

// --- Checkpoint Durability -----------------------------------------------

const checkpointStore = memoryStore();

const checkpointSupport = Agent.create('support-checkpoint')
  .system('Collect the order id, then resolve the issue.')
  .inbox('issue')
  .assistant('clarify', Source.llm())
  .awaitInput('order-id')
  .assistant('resolve', Source.llm());

const first = await checkpointSupport.execute({
  runId: 'ticket-42',
  input: 'My order never arrived.',
  checkpoint: checkpointStore,
});
console.log(first.status, first.awaiting);

const done = await checkpointSupport.execute({
  runId: 'ticket-42',
  input: 'Order #1234',
  checkpoint: checkpointStore,
});
console.log(done.status, done.session.getLastMessage()?.content);

// --- Durable timers (sleep) ----------------------------------------------

const reminder = Agent.create('reminder')
  .sleep('wait', '7d')
  .assistant('nudge', Source.llm());
// run suspends at 'reminder/wait'; a week later the app's timer sweep resumes
// it past the sleep and the assistant delivers.
void reminder;

// --- Vendor Tool Loops ---------------------------------------------------

void Source.llm().openai().toolLoop('vendor').addTool('searchDocs', searchDocs);
void Source.llm()
  .openai({ adapter: 'ai-sdk' })
  .addTool('searchDocs', searchDocs);

// --- Transforms ----------------------------------------------------------

const withVarsAgent = Agent.create('with-vars')
  .transform((session) => session.withVar('attempt', 1))
  .assistant('Ready.');
void withVarsAgent;

const fetchProfileAgent = Agent.create<Vars<{ userId: string }>>(
  'fetch-profile',
).transform({ effect: { repeatable: true } }, async (session) => {
  const profile = await fetchProfile(session.getVar('userId'));
  return session.withVar('profile', profile);
});
void fetchProfileAgent;

// --- Goals and Tool Loops ------------------------------------------------

const researcher = Agent.create('researcher')
  .system('Research before answering.')
  .tool('searchDocs', searchDocs)
  .goal('Gather evidence for the inbound question.', {
    tools: ['searchDocs'],
    maxAttempts: 4,
    isSatisfied: ({ session }) =>
      session.getMessagesByType('tool_result').length >= 2,
  })
  .goal('Write the final answer.');
void researcher;

// --- Structured Output ---------------------------------------------------

declare function escalate(category: string): void;

const triageSchema = z.object({ category: z.string(), urgent: z.boolean() });
type TriageVars = Vars<{ triage?: z.infer<typeof triageSchema> }>;

const classifier = Agent.create<TriageVars>('classifier')
  .inbox()
  .structured('triage', triageSchema, (triage, session) =>
    session.withVar('triage', triage),
  );

const classified = await classifier.execute({
  input: 'My payment failed twice!',
});
const triage = classified.getVar('triage');
if (triage?.urgent) escalate(triage.category);

const latestTriage = classified.getStructured(triageSchema);
void latestTriage;

// --- Subroutines ---------------------------------------------------------

const review = Agent.create<Vars<{ draft: string }>>('review').subroutine(
  'draft-review',
  (draft) =>
    draft
      .system('Review the draft in isolation.')
      .user('Please check tone and clarity.')
      .assistant(Source.llm()),
  {
    init: (parent) => parent.withVars({ draft: parent.getVar('draft') }),
    squash: (parent, sub) =>
      parent.withVar('review', sub.getLastMessage()?.content ?? ''),
  },
);
void review;

// --- Provider Turns ------------------------------------------------------

const coding = Agent.create('coding').codex({
  transport: { kind: 'websocket', url: 'ws://127.0.0.1:8390' },
  cwd: process.cwd(),
  onUnresumable: 'restart',
  restartNotice:
    'The previous provider turn was interrupted. Restart and continue.',
  maxRestarts: 1,
});
void coding;

// --- App Runtime / Binding DSL -------------------------------------------

const discordSupport = Agent.create('discord-support')
  .system('Answer Discord support questions.')
  .inbox()
  .assistant(Source.llm());

const app = PromptTrail.app({
  name: 'support-bot',
  store: memoryStore(),
  defaults: { checkpoint: true },
  adapters: [discordGateway({ token: process.env.DISCORD_TOKEN })],
  presence: { kind: 'typing' },
})
  .agent(discordSupport)
  .on(discord.messages(), (b) =>
    b
      .where(discord.notBot())
      .to(discordSupport)
      .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
      .input((event) => event.content)
      .reply(discord.replyToOriginThread()),
  );

app.on(discord.messages(), (b) =>
  b
    .to('discord-support')
    .conversation(discord.sessionKey({ groupSessionsPerUser: true }))
    .input((event) => event.content)
    .reply(discord.replyToOriginThread())
    .where(discord.notBot())
    .context((event) => ({ channel: event.channel })),
);

const bundle = app.bundle();
console.log(bundle.bindings[0].agent);

declare const SHOULD_START: boolean;
if (SHOULD_START) {
  await app.start();
}
