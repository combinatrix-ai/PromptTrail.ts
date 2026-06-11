import {
  Agent,
  PromptTrail,
  Source,
  Tool,
  memoryStore,
  type MessageType,
  type ModelOutput,
} from '@prompttrail/core';
import { z } from 'zod';

type SupportMessageType = Exclude<MessageType['type'], 'system'>;

export interface SupportChatMessage {
  type: SupportMessageType;
  content: string;
}

export interface SupportChatResponse {
  status: 'done' | 'suspended';
  messages: SupportChatMessage[];
}

type SupportModelSource = Source<ModelOutput> | Source<string>;

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

export function createSupportAgent(
  modelSource: SupportModelSource = defaultSupportModelSource(),
) {
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
}

export function getRefundRecords(): readonly RefundRecord[] {
  return refundRecords;
}

export function resetSupportDemoRecords(): void {
  refundRecords.length = 0;
}

export function createSupportRuntime(
  modelSource: SupportModelSource = defaultSupportModelSource(),
) {
  const support = createSupportAgent(modelSource);
  const app = PromptTrail.app({
    agents: { support },
    store: memoryStore(),
    defaults: { checkpoint: true },
  });

  return {
    app,
    support,
    handleMessage: (conversationId: string, message: string) =>
      handleMessageWithApp(app, conversationId, message),
  };
}

const support = createSupportAgent();

export const app = PromptTrail.app({
  agents: { support },
  store: memoryStore(),
  defaults: { checkpoint: true },
});

export async function handleMessage(
  conversationId: string,
  message: string,
): Promise<SupportChatResponse> {
  return handleMessageWithApp(app, conversationId, message);
}

async function handleMessageWithApp(
  runtime: ReturnType<typeof PromptTrail.app>,
  conversationId: string,
  message: string,
): Promise<SupportChatResponse> {
  const result = await runtime.send({
    agent: 'support',
    runId: conversationId,
    input: message,
  });

  return {
    status: result.status,
    messages: result.session.messages
      .filter((item): item is MessageType & { type: SupportMessageType } => {
        return item.type !== 'system';
      })
      .map((item) => ({
        type: item.type,
        content: item.content,
      })),
  };
}
