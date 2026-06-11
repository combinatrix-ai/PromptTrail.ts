import { NextResponse } from 'next/server';
import { handleMessage, type SupportAgentName } from '@/lib/support-agent';

interface ChatRequest {
  conversationId?: unknown;
  message?: unknown;
  agent?: unknown;
}

export async function POST(req: Request) {
  const body = (await req.json()) as ChatRequest;

  if (
    typeof body.conversationId !== 'string' ||
    typeof body.message !== 'string'
  ) {
    return NextResponse.json(
      { error: 'Expected { conversationId: string, message: string }.' },
      { status: 400 },
    );
  }

  const agent =
    body.agent === 'returns' || body.agent === 'support'
      ? (body.agent as SupportAgentName)
      : 'support';

  const result = await handleMessage(body.conversationId, body.message, agent);
  return NextResponse.json(result);
}
