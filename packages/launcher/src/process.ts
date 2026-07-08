import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { LAUNCHER_ENV } from './types';
import type { DeployTarget, LaunchedProcess, ServerRole } from './types';

export interface LaunchServerOptions {
  /** Lease holder id the child must use (injected as LAUNCHER_LEASE_HOLDER). */
  holder: string;
  role: ServerRole;
  ttlMs: number;
  /** File the child touches when it is initialized + polling for the lease. */
  readyFile: string;
  /** File the child rewrites each tick with its {serving, token, ...} status. */
  statusFile: string;
}

/**
 * Spawn a server child from `target.serve`, injecting only the launcher-owned
 * handshake env (role, holder, ttl, ready/status file paths). The child owns its
 * own store/lease config via `target.serve.env`. Returns a {@link
 * LaunchedProcess} handle the launcher uses to await readiness and reap the
 * process; the store lease — not this handle — decides who actually serves.
 */
export function launchServer(
  target: DeployTarget,
  opts: LaunchServerOptions,
): LaunchedProcess {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(target.serve.env ?? {}),
    [LAUNCHER_ENV.role]: opts.role,
    [LAUNCHER_ENV.holder]: opts.holder,
    [LAUNCHER_ENV.ttlMs]: String(opts.ttlMs),
    [LAUNCHER_ENV.readyFile]: opts.readyFile,
    [LAUNCHER_ENV.statusFile]: opts.statusFile,
  };

  const child: ChildProcess = spawn(target.serve.command, target.serve.args, {
    cwd: target.serve.cwd,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let exited = false;
  let exitError: Error | undefined;
  child.once('exit', (code, signal) => {
    exited = true;
    if (code && code !== 0) {
      exitError = new Error(
        `${opts.role} child exited early with code ${code}` +
          (signal ? ` (signal ${signal})` : ''),
      );
    }
  });
  child.once('error', (error) => {
    exited = true;
    exitError = error instanceof Error ? error : new Error(String(error));
  });

  const handle: LaunchedProcess = {
    holder: opts.holder,
    role: opts.role,
    get pid() {
      return child.pid;
    },
    statusFile: opts.statusFile,
    get exited() {
      return exited;
    },
    async waitReady(timeoutMs = 10_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (existsSync(opts.readyFile)) {
          return;
        }
        if (exited) {
          throw (
            exitError ??
            new Error(`${opts.role} child exited before signaling ready`)
          );
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `${opts.role} child did not signal ready within ${timeoutMs}ms`,
          );
        }
        await delay(25);
      }
    },
    async stop(timeoutMs = 5_000): Promise<void> {
      if (exited) {
        return;
      }
      const done = onceExit(child);
      child.kill('SIGTERM');
      const timedOut = await Promise.race([
        done.then(() => false),
        delay(timeoutMs).then(() => true),
      ]);
      if (timedOut && !exited) {
        child.kill('SIGKILL');
        await done;
      }
    },
    kill(): void {
      if (!exited) {
        child.kill('SIGKILL');
      }
    },
  };
  return handle;
}

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
