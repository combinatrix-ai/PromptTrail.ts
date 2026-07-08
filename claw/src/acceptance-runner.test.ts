import { describe, expect, it } from 'vitest';
import {
  formatAcceptanceReport,
  runClawAcceptance,
} from './acceptance-runner.js';

/**
 * B3 — the trusted-runner acceptance corpus, invoked in-process (not as a
 * subprocess). The runner builds claw's dispatch agent and runs the trusted-root
 * corpus against it through the core acceptance containment.
 */
describe('claw builtin acceptance corpus', () => {
  it('passes every case through the trusted runner', async () => {
    const report = await runClawAcceptance();
    // Surface the specific failing case(s) if the corpus regresses.
    if (!report.ok) {
      throw new Error(
        `acceptance regressed:\n${formatAcceptanceReport(report)}`,
      );
    }
    expect(report.ok).toBe(true);
    expect(report.cases).toHaveLength(5);
    for (const result of report.cases) {
      expect(result.ok).toBe(true);
      expect(typeof result.durationMs).toBe('number');
    }
  });
});
