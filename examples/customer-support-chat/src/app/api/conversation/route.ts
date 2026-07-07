import { NextResponse } from 'next/server';
import { readConversation } from '@/lib/support-agent';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId');

  if (!conversationId) {
    return NextResponse.json(
      { error: 'Expected conversationId query parameter.' },
      { status: 400 },
    );
  }

  return NextResponse.json(await readConversation(conversationId));
}
