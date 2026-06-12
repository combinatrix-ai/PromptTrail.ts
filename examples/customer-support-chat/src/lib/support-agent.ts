import {
  Agent,
  PromptTrail,
  Source,
  Structured,
  Tool,
  memoryStore,
  type DurableRunStore,
  type MessageType,
  type ModelOutput,
  type Session,
  type Vars,
} from '@prompttrail/core';
import { z } from 'zod';
import { SqliteRunStore } from './sqlite-store';

export type SupportAgentName = 'support' | 'returns';
type SupportMessageType = Exclude<MessageType['type'], 'system'>;

export interface SupportChatMessage {
  type: SupportMessageType;
  content: string;
  structuredContent?: unknown;
}

export interface SupportChatResponse {
  status: 'done' | 'suspended';
  awaiting?: string;
  messages: SupportChatMessage[];
}

type SupportModelSource = Source<ModelOutput> | Source<string>;
type ReturnsModelSource = Source<ModelOutput>;
type ReturnWizardVars = Vars<{
  refundedOrderId?: string;
  refundId?: string;
}>;

interface OrderRecord {
  orderId: string;
  customer: string;
  item: string;
  status: 'processing' | 'shipped' | 'delivered';
  total: string;
  refundable: boolean;
}

export interface RefundRecord {
  orderId: string;
  reason: string;
  idempotencyKey: string | undefined;
}

export interface ReturnTransformInspection {
  type: MessageType['type'];
  content: string;
}

const orders: Record<string, OrderRecord> = {
  'ORD-1001': {
    orderId: 'ORD-1001',
    customer: 'Mina Tanaka',
    item: 'Trail Runner Backpack',
    status: 'shipped',
    total: '$129.00',
    refundable: true,
  },
  'ORD-1002': {
    orderId: 'ORD-1002',
    customer: 'Jules Carter',
    item: 'Insulated Camp Mug',
    status: 'delivered',
    total: '$24.00',
    refundable: true,
  },
  'ORD-1003': {
    orderId: 'ORD-1003',
    customer: 'Sam Rivera',
    item: 'Warranty Replacement Strap',
    status: 'processing',
    total: '$0.00',
    refundable: false,
  },
};

const refundRecords: RefundRecord[] = [];
const returnTransformInspections: ReturnTransformInspection[] = [];

const returnChoiceSchema = z.object({
  reply: z.string(),
  choices: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
    }),
  ),
});

// demo-source:tools:start
const lookupOrder = Tool.create({
  name: 'lookupOrder',
  description: 'Look up customer order status and refund eligibility.',
  inputSchema: z.object({
    orderId: z.string().describe('The order id, such as ORD-1001.'),
  }),
  effect: { repeatable: true },
  execute: ({ orderId }) => {
    const order = orders[orderId];
    if (!order) {
      return {
        found: false,
        orderId,
        message: 'No order found for that id.',
      };
    }
    return {
      found: true,
      ...order,
    };
  },
});

const issueRefund = Tool.create({
  name: 'issueRefund',
  description: 'Issue a customer refund for a refundable order.',
  inputSchema: z.object({
    orderId: z.string().describe('The order id to refund.'),
    reason: z.string().describe('A brief customer-facing refund reason.'),
  }),
  effect: {
    idempotencyKey: (input) =>
      `refund:${(input as { orderId: string }).orderId}`,
  },
  execute: ({ orderId, reason }, ctx) => {
    const record = {
      orderId,
      reason,
      idempotencyKey: ctx.idempotencyKey,
    };
    refundRecords.push(record);
    return {
      ok: true,
      refundId: `RF-${orderId}`,
      idempotencyKey: ctx.idempotencyKey,
    };
  },
});
// demo-source:tools:end

// The model only calls tools whose definitions reach the provider request,
// and that wiring lives on the SOURCE: the ai-sdk adapter surfaces tool
// calls/results onto the session, so the chat UI can show them. The
// agent-level .tool(...) registrations below feed the execution registry and
// the checkpoint gate.
function defaultSupportModelSource(): SupportModelSource {
  return Source.llm()
    .openai({ adapter: 'ai-sdk' })
    .addTool('lookupOrder', lookupOrder)
    .addTool('issueRefund', issueRefund);
}

function defaultReturnsModelSource(): ReturnsModelSource {
  return Source.llm().openai({ adapter: 'ai-sdk' });
}

function orderChoices() {
  return Object.values(orders).map((order) => ({
    id: order.orderId,
    label: `${order.orderId} - ${order.item}`,
  }));
}

function selectedOrderIdFromSession(session: Session): string {
  const selected = session.getLastMessage()?.content;
  return typeof selected === 'string' ? selected.trim() : '';
}

export function createSupportAgent(
  modelSource: SupportModelSource = defaultSupportModelSource(),
) {
  // demo-source:support:start
  return Agent.create('support')
    .system(
      'persona',
      [
        'You are a concise, careful customer-support agent for Trail Supply.',
        'Answer from the conversation and tools. Ask one focused question when information is missing.',
        'Before promising refunds, look up the order and use the refund tool only for eligible orders.',
      ].join(' '),
    )
    .tool('lookupOrder', lookupOrder)
    .tool('issueRefund', issueRefund)
    .inbox('customer-message')
    .assistant('reply', modelSource);
  // demo-source:support:end
}

export function createReturnsAgent(
  modelSource: ReturnsModelSource = defaultReturnsModelSource(),
) {
  // demo-source:returns:start
  return Agent.create<ReturnWizardVars>('returns')
    .system(
      'policy',
      [
        'You are the Trail Supply return wizard.',
        'The customer is choosing from these demo orders:',
        'ORD-1001 Trail Runner Backpack is refundable.',
        'ORD-1002 Insulated Camp Mug is refundable.',
        'ORD-1003 Warranty Replacement Strap is not refundable.',
        `Emit exactly these choices: ${orderChoices()
          .map((choice) => `${choice.id} (${choice.label})`)
          .join(', ')}.`,
        'Ask the customer to choose one order and emit choices for every demo order.',
      ].join(' '),
    )
    .inbox('reason')
    .structured(
      'ask-order',
      Structured.withSource(modelSource, returnChoiceSchema),
    )
    .awaitInput('order-choice')
    .conditional(
      'eligible',
      ({ session }) => {
        const orderId = selectedOrderIdFromSession(session);
        return orders[orderId]?.refundable === true;
      },
      (approve) =>
        approve
          .transform(
            'issue-refund',
            {
              effect: {
                idempotencyKey: (session) =>
                  `refund:${selectedOrderIdFromSession(session as Session)}`,
              },
            },
            async (session, ctx) => {
              const lastMessage = session.getLastMessage();
              returnTransformInspections.push({
                type: lastMessage?.type ?? 'user',
                content: lastMessage?.content ?? '',
              });

              const orderId = selectedOrderIdFromSession(session);
              const record = {
                orderId,
                reason:
                  session.getMessagesByType('user').at(0)?.content ??
                  'Return requested.',
                idempotencyKey: ctx.idempotencyKey,
              };
              refundRecords.push(record);

              return session.withVars({
                refundedOrderId: orderId,
                refundId: `RF-${orderId}`,
              });
            },
          )
          .assistant('confirmation', (session) => {
            const refundId = session.getVar('refundId', 'RF-UNKNOWN');
            const orderId = session.getVar('refundedOrderId', 'that order');
            return `Refund ${refundId} has been issued for ${orderId}.`;
          }),
      (deny) =>
        deny.assistant('ineligible', (session) => {
          const orderId = selectedOrderIdFromSession(session);
          const order = orders[orderId];
          if (!order) {
            return 'I could not find that order in the demo return list.';
          }
          return `${order.orderId} is not eligible for a refund.`;
        }),
    );
  // demo-source:returns:end
}

export function createSupportAgents(
  modelSource: SupportModelSource = defaultSupportModelSource(),
  returnsModelSource: ReturnsModelSource = defaultReturnsModelSource(),
) {
  const support = createSupportAgent(modelSource);
  const returns = createReturnsAgent(returnsModelSource);
  return { support, returns };
}

export function getRefundRecords(): readonly RefundRecord[] {
  return refundRecords;
}

export function getReturnTransformInspections(): readonly ReturnTransformInspection[] {
  return returnTransformInspections;
}

export function resetSupportDemoRecords(): void {
  refundRecords.length = 0;
  returnTransformInspections.length = 0;
}

export function createSupportRuntime(
  modelSource: SupportModelSource = defaultSupportModelSource(),
  returnsModelSource: ReturnsModelSource = defaultReturnsModelSource(),
  store?: DurableRunStore,
) {
  const agents = createSupportAgents(modelSource, returnsModelSource);
  const runtimeStore = store ?? memoryStore();
  const app = PromptTrail.app({
    agents,
    store: runtimeStore,
    defaults: { checkpoint: true },
  });

  return {
    app,
    store: runtimeStore,
    support: agents.support,
    returns: agents.returns,
    handleMessage: (
      conversationId: string,
      message: string,
      agent: SupportAgentName = 'support',
    ) => handleMessageWithApp(app, conversationId, message, agent),
    readConversation: (conversationId: string) =>
      readConversationFromStore(runtimeStore, conversationId),
  };
}

export const agents = createSupportAgents();
export const store = new SqliteRunStore({ agents });

export const app = PromptTrail.app({
  agents,
  store,
  defaults: { checkpoint: true },
});

export async function handleMessage(
  conversationId: string,
  message: string,
  agent: SupportAgentName = 'support',
): Promise<SupportChatResponse> {
  return handleMessageWithApp(app, conversationId, message, agent);
}

export function sanitizeUserName(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) {
    throw new Error('User name must contain at least one letter or number.');
  }
  return sanitized;
}

export function conversationIdFor(
  agent: SupportAgentName,
  userName: string,
): string {
  return `${agent}:${sanitizeUserName(userName)}`;
}

export function listStoredUsers(
  durableStore: DurableRunStore = store,
): string[] {
  const users = new Set<string>();
  for (const [runId] of durableStore.entries()) {
    const match = /^(?:support|returns):([a-z0-9-]+)$/.exec(runId);
    if (match) {
      users.add(match[1]);
    }
  }
  return [...users].sort();
}

export function readConversation(
  conversationId: string,
  durableStore: DurableRunStore = store,
): SupportChatResponse {
  return readConversationFromStore(durableStore, conversationId);
}

async function handleMessageWithApp(
  runtime: ReturnType<typeof PromptTrail.app>,
  conversationId: string,
  message: string,
  agent: SupportAgentName,
): Promise<SupportChatResponse> {
  const result = await runtime.send({
    agent,
    runId: conversationId,
    input: message,
  });

  return {
    status: result.status,
    awaiting: result.awaiting,
    messages: projectSessionMessages(result.session),
  };
}

function readConversationFromStore(
  durableStore: DurableRunStore,
  conversationId: string,
): SupportChatResponse {
  const run = durableStore.get(conversationId);
  if (!run) {
    return { status: 'done', messages: [] };
  }
  const session = run.result ?? run.initial;
  return {
    status: run.graphSuspendedAt ? 'suspended' : 'done',
    awaiting: run.graphSuspendedAt,
    messages: projectSessionMessages(session),
  };
}

function projectSessionMessages(session: Session): SupportChatMessage[] {
  return session.messages
    .filter((item): item is MessageType & { type: SupportMessageType } => {
      return item.type !== 'system';
    })
    .map((item) => {
      const projected: SupportChatMessage = {
        type: item.type,
        content: item.content,
      };
      if ('structuredContent' in item && item.structuredContent !== undefined) {
        projected.structuredContent = item.structuredContent;
      }
      return projected;
    });
}
