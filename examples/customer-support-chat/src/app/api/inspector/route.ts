import { NextResponse } from 'next/server';
import { getInspectorPayload } from '@/lib/inspector';
import type { SupportAgentName } from '@/lib/support-agent';

export function GET(req: Request) {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId');
  const agentParam = url.searchParams.get('agent');

  if (!conversationId) {
    return NextResponse.json(
      { error: 'Expected conversationId query parameter.' },
      { status: 400 },
    );
  }

  const agentName: SupportAgentName =
    agentParam === 'returns' || agentParam === 'support'
      ? agentParam
      : 'support';

  return NextResponse.json(
    getInspectorPayload({
      conversationId,
      agentName,
    }),
  );
}
