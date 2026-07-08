import { Agent, Session, Source } from '@prompttrail/core';

/**
 * Skill synthesis (design-docs/claw-self-authoring.md §4 step 3).
 *
 * A synthesizer turns a natural-language instruction into the TypeScript source
 * of a Phase 1 skill module (see skill-module.ts for the format). It is a
 * dependency of the authoring pipeline so the pipeline can be driven
 * deterministically in tests (templateSynthesizer) and by an LLM in production
 * (llmSynthesizer). The synthesizer NEVER activates anything — its output goes
 * straight into the verification gate.
 */
export interface SkillSynthesizer {
  synthesize(instruction: string): Promise<string>;
}

/** Parsed intent extracted from an instruction (template path). */
interface ParsedSkillSpec {
  id: string;
  name: string;
  description: string;
  startsWith?: string;
  channels?: string[];
  examples: string[];
  systemPrompt: string;
}

/** Turn an arbitrary token into a stable graph id (letter-led, alnum/`-`/`_`). */
function slugifyId(token: string): string {
  let slug = token
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length === 0) {
    slug = 'skill';
  }
  if (!/^[a-z]/.test(slug)) {
    slug = `s-${slug}`;
  }
  return slug;
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Deterministic instruction → spec parse (template synthesizer only).
 *
 * Recognizes, case-insensitively:
 *   - `starts with "<prefix>"` / `starts with <prefix>` — the trigger prefix;
 *     otherwise the first `!token` in the instruction is used as the prefix.
 *   - `in channel <name>` / `in #<name>` — a channel narrowing.
 * Everything else is carried as the behavior's system prompt.
 */
export function parseInstruction(instruction: string): ParsedSkillSpec {
  const text = instruction.trim();

  let startsWith: string | undefined;
  const startsWithMatch = text.match(/starts?\s*with\s+["']?([^\s"']+)["']?/i);
  if (startsWithMatch) {
    startsWith = startsWithMatch[1];
  } else {
    const bangMatch = text.match(/(^|\s)(![^\s]+)/);
    if (bangMatch) {
      startsWith = bangMatch[2];
    }
  }

  let channels: string[] | undefined;
  const channelMatch = text.match(
    /(?:^|\s)in\s+(?:channel\s+)?#?([A-Za-z0-9_-]+)/i,
  );
  if (channelMatch) {
    channels = [channelMatch[1]];
  }

  const idSeed = startsWith ?? text.split(/\s+/).slice(0, 3).join('-');
  const id = slugifyId(idSeed);
  const name = titleCase(id);
  const examples = startsWith
    ? [startsWith, `${startsWith} example input`]
    : [text.slice(0, 60) || 'hello'];

  return {
    id,
    name,
    description: `Auto-authored skill from instruction: ${text.slice(0, 120)}`,
    startsWith,
    channels,
    examples,
    systemPrompt: `You are "${name}", a focused claw skill. Follow this instruction when replying: ${text}`,
  };
}

/** Render a {@link ParsedSkillSpec} to Phase 1 skill-module TypeScript source. */
export function renderSkillModule(spec: ParsedSkillSpec): string {
  const triggerParts: string[] = [];
  if (spec.channels) {
    triggerParts.push(`channels: ${JSON.stringify(spec.channels)}`);
  }
  if (spec.startsWith) {
    triggerParts.push(`startsWith: ${JSON.stringify(spec.startsWith)}`);
  }
  const trigger =
    triggerParts.length > 0 ? `{ ${triggerParts.join(', ')} }` : '{}';

  return `import type { Agent, Source } from '@prompttrail/core';

export const meta = {
  id: ${JSON.stringify(spec.id)},
  name: ${JSON.stringify(spec.name)},
  description: ${JSON.stringify(spec.description)},
};

export const trigger = ${trigger};

export const examples: string[] = ${JSON.stringify(spec.examples)};

export function behavior(agent: Agent, reply: Source<string>): Agent {
  return agent
    .system(${JSON.stringify(spec.systemPrompt)})
    .assistant('reply', reply);
}
`;
}

/**
 * Deterministic synthesizer for tests and echo-mode operation: parses the
 * instruction and fills the fixed module template. No LLM, no network.
 */
export const templateSynthesizer: SkillSynthesizer = {
  async synthesize(instruction: string): Promise<string> {
    return renderSkillModule(parseInstruction(instruction));
  },
};

const LLM_SYSTEM_PROMPT = `You author PromptTrail "claw" skill modules. Output ONLY a single TypeScript module (no prose, no markdown fences) matching EXACTLY this shape:

import type { Agent, Source } from '@prompttrail/core';
export const meta = { id: string, name: string, description: string };
export const trigger = { channels?: string[]; startsWith?: string; regex?: string };
export const examples: string[]; // >=1 trigger examples; the gate runs each
export function behavior(agent: Agent, reply: Source<string>): Agent {
  return agent.system('...').assistant('reply', reply);
}

Hard rules:
- meta.id must match /^[A-Za-z][A-Za-z0-9_-]*$/.
- Import from '@prompttrail/core' using 'import type' ONLY. Do NOT import any runtime value.
- The reply MUST use the injected 'reply' Source parameter. Do NOT construct Source.llm() or any other source, register tools, or call transform — Phase 1 skills are prompt-only and read-only.
- trigger is data only (channels + startsWith/regex). No arbitrary predicates.
- Provide at least one string in examples.`;

/** Extract a TS module from an LLM response that may wrap it in code fences. */
export function stripCodeFences(text: string): string {
  const fenced = text.match(/```(?:ts|typescript)?\s*\n([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }
  return text.trim();
}

/**
 * Production synthesizer: asks claw's configured OpenAI model to emit a module.
 * Only wired when claw's reply mode is openai (see index.ts).
 */
export function llmSynthesizer(options: {
  modelName: string;
}): SkillSynthesizer {
  return {
    async synthesize(instruction: string): Promise<string> {
      const agent = Agent.create('skill-synthesizer')
        .system('prompt', LLM_SYSTEM_PROMPT)
        .user('instruction', instruction)
        .assistant(
          'module',
          Source.llm().openai({
            adapter: 'ai-sdk',
            modelName: options.modelName,
          }),
        );
      const result = (await agent.execute({
        session: Session.create(),
      })) as Session;
      return stripCodeFences(result.getLastMessage()?.content ?? '');
    },
  };
}
