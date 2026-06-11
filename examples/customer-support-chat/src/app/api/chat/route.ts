import { NextResponse } from 'next/server';
import { handleMessage } from '@/lib/support-agent';

interface ChatRequest {
  conversationId?: unknown;
  message?: unknown;
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

  const result = await handleMessage(body.conversationId, body.message);
  return NextResponse.json(result);
}
