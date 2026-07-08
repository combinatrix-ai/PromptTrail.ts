/**
 * @prompttrail/launcher — B5, the immutable blue/green deploy launcher.
 *
 * This package is the TRUST ROOT of a self-modifying deployment (design-docs
 * replay-and-self-deploy.md §5–§8). It must be installed/pinned OUTSIDE the
 * candidate's write paths: claw's self-authoring only ever writes its `.data`
 * dirs, never this package, so a self-modified build can never weaken the gate
 * or seize the lease. See the package README for the immutability posture.
 *
 * It composes the already-merged machinery — B1 replay, B2 differ + ChangeScope,
 * B3 acceptance, B4 store lease + fencing — and adds the irreversible cutover:
 * verify → launch green → hand off the single-writer lease → health window →
 * auto-rollback. The launcher decides; green only supplies evidence.
 */
export { deploy } from './deploy';
export { verifyCandidate } from './verify';
export type { VerifyResult } from './verify';
export { launchServer } from './process';
export type { LaunchServerOptions } from './process';
export {
  deserializeRunFixture,
  readRunFixtures,
  serializeRunFixture,
} from './fixtures';
export type { LoadedFixture, RunFixture } from './fixtures';
export { LAUNCHER_ENV } from './types';
export type {
  DeployLogEvent,
  DeployOptions,
  DeployReport,
  DeployTarget,
  DeployVerdict,
  FixtureDiff,
  LaunchedProcess,
  ProbeContext,
  ServerRole,
} from './types';
