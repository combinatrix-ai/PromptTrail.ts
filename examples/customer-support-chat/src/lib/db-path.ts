import { join } from 'node:path';
import { cwd } from 'node:process';

export function defaultSupportDbPath(): string {
  if (cwd().endsWith(join('examples', 'customer-support-chat'))) {
    return join(cwd(), '.data', 'support.db');
  }
  return join(
    cwd(),
    'examples',
    'customer-support-chat',
    '.data',
    'support.db',
  );
}
