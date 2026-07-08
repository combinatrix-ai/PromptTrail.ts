import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runGate, type GateOptions, type GateResult } from './gate.js';
import { SkillRegistry, type SkillTier } from './registry.js';
import {
  assertSkillModule,
  skillFromModule,
  triggerPredicateKey,
  type SkillModule,
  type SkillReplySource,
} from './skill-module.js';
import type { Skill, SkillProvenance } from './types.js';

/**
 * Hot-load + boot reload of self-authored skills
 * (design-docs/claw-self-authoring.md §4 step 6, §7).
 *
 * On gate pass a skill is PROMOTED: its `.ts` source and built `.js` artifact
 * are copied from the ephemeral staging dir into a durable skills dir
 * (`CLAW_SKILLS_DIR`), then the built artifact is dynamic-imported and
 * registered into the in-process behavior map + the registry. No restart, no
 * parent-graph recompile (the §3 payoff — the parent graph stays static).
 *
 * On restart the boot loader walks every enabled non-builtin row and re-imports
 * its built artifact through the SAME path, re-running the full gate only when
 * the on-disk source hash changed (§7).
 */

export interface SkillLoaderContext {
  registry: SkillRegistry;
  /** In-process behavior map the dispatcher joins against (mutated in place). */
  skills: Map<string, Skill>;
  /** Durable directory the promoted `.ts`/`.js` live in. */
  skillsDir: string;
  /** Production reply source injected into every loaded skill's behavior. */
  replySource: SkillReplySource;
  /** Gate configuration (used for reload re-gating and rebuilds). */
  gateOptions: GateOptions;
}

export function hashSource(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function durableTsPath(dir: string, id: string): string {
  return join(dir, `${id}.ts`);
}

function durableJsPath(dir: string, id: string): string {
  return join(dir, `${id}.js`);
}

/**
 * Per-version, content-addressed artifact paths (design-docs §9). Rollback
 * imports a *past* version's built `.js`, so every gated build keeps an
 * immutable copy keyed by manifest hash under `<skillsDir>/versions/`, distinct
 * from the mutable "live" `<id>.js` that promotion overwrites.
 */
export function versionedTsPath(dir: string, id: string, hash: string): string {
  return join(dir, 'versions', `${id}.${hash}.ts`);
}

export function versionedJsPath(dir: string, id: string, hash: string): string {
  return join(dir, 'versions', `${id}.${hash}.js`);
}

/** Import a built `.js` artifact fresh (cache-busted) and structurally validate it. */
export async function importModule(jsPath: string): Promise<SkillModule> {
  const imported = await import(
    `${pathToFileURL(jsPath).href}?t=${Date.now()}`
  );
  assertSkillModule(imported);
  return imported;
}

/**
 * Register an already-validated module into the in-process map + registry row.
 * Shared by hot-load and boot reload so both paths write identical provenance.
 */
function registerModule(
  ctx: SkillLoaderContext,
  module: SkillModule,
  meta: {
    sourceHash: string;
    manifestHash: string | null;
    gateResult: GateResult | null;
    provenance: SkillProvenance;
    createdAt: string;
    /** Tier to persist. Fresh promotion passes 'canary'; reload preserves. */
    tier: SkillTier;
  },
): Skill {
  const skill = skillFromModule(module, {
    reply: ctx.replySource,
    provenance: meta.provenance,
  });
  ctx.skills.set(skill.id, skill);
  const durableTs = durableTsPath(ctx.skillsDir, module.meta.id);
  ctx.registry.upsert({
    id: module.meta.id,
    name: module.meta.name,
    channel: module.trigger.channels ?? null,
    predicateKey: triggerPredicateKey(module.trigger),
    behaviorRef: module.meta.id,
    provenance: meta.provenance,
    enabled: true,
    createdAt: meta.createdAt,
    tier: meta.tier,
    sourcePath: durableTs,
    sourceHash: meta.sourceHash,
    manifestHash: meta.manifestHash,
    activeVersion: meta.manifestHash,
    gateResult: meta.gateResult,
  });
  if (meta.manifestHash) {
    ctx.registry.recordVersion({
      skillId: module.meta.id,
      manifestHash: meta.manifestHash,
      sourceHash: meta.sourceHash,
      sourcePath: versionedTsPath(
        ctx.skillsDir,
        module.meta.id,
        meta.manifestHash,
      ),
      gateResult: meta.gateResult,
      createdAt: meta.createdAt,
    });
  }
  return skill;
}

/**
 * Promote a gate-passed skill from staging into the durable skills dir and
 * register it live. Reuses the module the gate already imported and validated;
 * only copies the artifacts (no rebuild) since the durable `.js` is byte-equal.
 */
export function promoteAndRegister(
  ctx: SkillLoaderContext,
  args: {
    module: SkillModule;
    stagingSourcePath: string;
    stagingBuiltPath: string;
    source: string;
    gateResult: GateResult;
    provenance: SkillProvenance;
  },
): Skill {
  mkdirSync(ctx.skillsDir, { recursive: true });
  mkdirSync(join(ctx.skillsDir, 'versions'), { recursive: true });
  const id = args.module.meta.id;
  const manifestHash = args.gateResult.manifestHash ?? null;

  // Live artifacts (overwritten each promotion) …
  copyFileSync(args.stagingSourcePath, durableTsPath(ctx.skillsDir, id));
  copyFileSync(args.stagingBuiltPath, durableJsPath(ctx.skillsDir, id));
  // … plus an immutable per-version copy so rollback can re-import a past build.
  if (manifestHash) {
    copyFileSync(
      args.stagingSourcePath,
      versionedTsPath(ctx.skillsDir, id, manifestHash),
    );
    copyFileSync(
      args.stagingBuiltPath,
      versionedJsPath(ctx.skillsDir, id, manifestHash),
    );
  }

  // Trust tiers (design-docs §9): a gate-passed build lands 'staged', then the
  // authoring flow immediately ACTIVATES it to 'canary' (live but closely
  // watched, read-only ceiling). Both transitions are audited; the persisted
  // tier is the terminal 'canary'.
  const prev = ctx.registry.get(id);
  const skill = registerModule(ctx, args.module, {
    sourceHash: hashSource(args.source),
    manifestHash,
    gateResult: args.gateResult,
    provenance: args.provenance,
    createdAt: args.provenance.createdAt,
    tier: 'canary',
  });
  const at = args.provenance.createdAt;
  const actor = args.provenance.authoredBy;
  ctx.registry.recordAudit({
    skillId: id,
    from: prev?.tier ?? '(new)',
    to: 'staged',
    reason: `gate passed (${args.gateResult.manifestHash ?? 'no-hash'})`,
    actor,
    at,
  });
  ctx.registry.recordAudit({
    skillId: id,
    from: 'staged',
    to: 'canary',
    reason: 'activated (live, read-only ceiling, close watch)',
    actor,
    at,
  });
  return skill;
}

/**
 * Boot reload: re-import every enabled, self-authored skill from its durable
 * source. Fast path (source hash unchanged AND built `.js` present) skips the
 * gate and imports directly. If the source changed on disk, re-run the FULL
 * gate before trusting it; a failed re-gate is warned and skipped (the row
 * stays but is not loaded into the live map).
 */
export async function loadStagedSkills(
  ctx: SkillLoaderContext,
  warn: (message: string) => void = console.warn,
): Promise<Skill[]> {
  const loaded: Skill[] = [];
  for (const row of ctx.registry.listReloadable()) {
    const sourcePath = row.sourcePath;
    if (!sourcePath || !existsSync(sourcePath)) {
      warn(
        `Skill "${row.id}": durable source missing at ${sourcePath ?? '<null>'}; skipping reload.`,
      );
      continue;
    }
    try {
      const source = readFileSync(sourcePath, 'utf8');
      const currentHash = hashSource(source);
      const jsPath = durableJsPath(ctx.skillsDir, row.id);

      if (row.sourceHash === currentHash && existsSync(jsPath)) {
        // Fast path: prior gate is still valid for this exact source. Preserve
        // the persisted tier (canary/trusted/quarantined) — a restart must not
        // silently re-stage a promoted skill or un-quarantine a broken one.
        const module = await importModule(jsPath);
        loaded.push(
          registerModule(ctx, module, {
            sourceHash: currentHash,
            manifestHash: row.manifestHash,
            gateResult: (row.gateResult as GateResult | null) ?? null,
            provenance: row.provenance,
            createdAt: row.createdAt,
            tier: row.tier,
          }),
        );
        continue;
      }

      // Source changed (or artifact missing): re-run the full gate.
      warn(
        `Skill "${row.id}": source hash changed since last gate; re-running the full gate.`,
      );
      const gate = await runGate({ id: row.id, source }, ctx.gateOptions);
      if (
        !gate.result.passed ||
        !gate.module ||
        !gate.builtPath ||
        !gate.sourcePath
      ) {
        const failed = gate.result.stages.find((s) => !s.ok);
        warn(
          `Skill "${row.id}": re-gate FAILED at "${failed?.name}" — ${failed?.detail}; not loaded.`,
        );
        continue;
      }
      loaded.push(
        promoteAndRegister(ctx, {
          module: gate.module,
          stagingSourcePath: gate.sourcePath,
          stagingBuiltPath: gate.builtPath,
          source,
          gateResult: gate.result,
          provenance: row.provenance,
        }),
      );
    } catch (error) {
      warn(
        `Skill "${row.id}": reload error — ${
          error instanceof Error ? error.message : String(error)
        }; skipping.`,
      );
    }
  }
  return loaded;
}
