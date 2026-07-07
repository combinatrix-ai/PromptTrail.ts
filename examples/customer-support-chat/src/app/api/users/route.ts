import { NextResponse } from 'next/server';
import { listStoredUsers } from '@/lib/support-agent';

export async function GET() {
  return NextResponse.json({ users: await listStoredUsers() });
}
