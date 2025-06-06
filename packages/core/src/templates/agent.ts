import { z } from 'zod';
import type { Attrs, Session, Vars } from '../session';
import type { Template } from './base';
import { Fluent } from './composite/chainable';
import { Loop } from './composite/loop';
import { Sequence } from './composite/sequence';
import { Subroutine } from './composite/subroutine';
import {
  Assistant,
  type AssistantContentInput,
  type AssistantTemplateOptions,
  type LLMConfig,
} from './primitives/assistant';
import { Conditional } from './primitives/conditional';
import {
  Parallel,
  ParallelBuilder,
  type ParallelConfig,
} from './primitives/parallel';
import { System, type SystemContentInput } from './primitives/system';
import { Transform } from './primitives/transform';
import {
  User,
  type UserContentInput,
  type UserTemplateOptions,
} from './primitives/user';
import { ISubroutineTemplateOptions } from './template_types';

export class Agent<TC extends Vars = Vars, TM extends Attrs = Attrs>
  implements Template<TM, TC>, Fluent<TM, TC>
{
  private constructor(
    private readonly root: Fluent<TM, TC> = new Sequence<TM, TC>(),
  ) {}

  static create<TC extends Vars = Vars, TM extends Attrs = Attrs>() {
    return new Agent<TC, TM>();
  }

  static system<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    contentOrSource: SystemContentInput,
  ) {
    return new Agent<TC, TM>().system(contentOrSource);
  }

  static user<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    content?: UserContentInput,
    options?: UserTemplateOptions,
  ) {
    return new Agent<TC, TM>().user(content, options);
  }

  static assistant<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    config?: AssistantContentInput,
    options?: AssistantTemplateOptions,
  ) {
    return new Agent<TC, TM>().assistant(config, options);
  }

  then(t: Template<TM, TC>) {
    this.root.then(t);
    return this;
  }

  system(contentOrSource: SystemContentInput) {
    this.root.then(new System(contentOrSource));
    return this;
  }

  user(content?: UserContentInput, options?: UserTemplateOptions) {
    this.root.then(new User(content, options));
    return this;
  }

  assistant(
    config?: AssistantContentInput,
    options?: AssistantTemplateOptions,
  ) {
    this.root.then(new Assistant(config, options));
    return this;
  }

  extract(config: LLMConfig & { schema: z.ZodType }): this;
  extract(config: LLMConfig & { schema: z.ZodType }, fields: string[]): this;
  extract(
    config: LLMConfig & { schema: z.ZodType },
    mapping: Record<string, string>,
  ): this;
  extract(
    config: LLMConfig & { schema: z.ZodType },
    extractConfig?: string[] | Record<string, string>,
  ): this {
    const { schema, mode, functionName, ...llmConfig } = config;

    const extractToVars = extractConfig || true;

    this.root.then(
      new Assistant(llmConfig, {
        schema,
        mode: mode || 'structured_output',
        functionName,
        extractToVars,
      }),
    );
    return this;
  }

  structured<TSchema extends z.ZodType>(
    schema: TSchema,
    options?: {
      provider?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      mode?: 'tool' | 'structured_output';
      functionName?: string;
      extractToVars?: boolean | string[] | Record<string, string>;
    },
  ): this {
    const {
      provider = 'openai',
      extractToVars,
      mode = 'structured_output',
      ...config
    } = options || {};

    const llmConfig: LLMConfig = {
      provider: provider as any,
      ...config,
    };

    if (extractToVars) {
      const extractConfig =
        typeof extractToVars === 'boolean' ? undefined : extractToVars;

      if (extractConfig) {
        if (Array.isArray(extractConfig)) {
          return this.extract(
            {
              ...llmConfig,
              schema,
              mode,
              functionName: options?.functionName,
            },
            extractConfig,
          );
        } else {
          return this.extract(
            {
              ...llmConfig,
              schema,
              mode,
              functionName: options?.functionName,
            },
            extractConfig,
          );
        }
      } else {
        return this.extract({
          ...llmConfig,
          schema,
          mode,
          functionName: options?.functionName,
        });
      }
    } else {
      this.root.then(
        new Assistant(llmConfig, {
          schema,
          mode,
          functionName: options?.functionName,
        }),
      );
      return this;
    }
  }

  transform(transform: (s: Session<TC, TM>) => Session<TC, TM>) {
    this.root.then(new Transform(transform));
    return this;
  }

  parallel(template: Parallel<TM, TC>): this;
  parallel(
    configFn: (builder: ParallelBuilder<TM, TC>) => ParallelBuilder<TM, TC>,
  ): this;
  parallel(
    templateOrConfig:
      | Parallel<TM, TC>
      | ((builder: ParallelBuilder<TM, TC>) => ParallelBuilder<TM, TC>),
  ): this {
    if (typeof templateOrConfig === 'function') {
      const builder = new ParallelBuilder<TM, TC>();
      const configuredBuilder = templateOrConfig(builder);
      const config = configuredBuilder.build();
      const parallel = new Parallel<TM, TC>(config);
      this.root.then(parallel);
    } else {
      this.root.then(templateOrConfig);
    }
    return this;
  }

  loop(
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    loopIf: boolean | ((s: Session<TC, TM>) => boolean),
    maxIterations?: number,
  ) {
    const innerAgent = Agent.create<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const bodyTemplate = builtAgent.build();

    const loopCondition = typeof loopIf === 'boolean' ? () => loopIf : loopIf;

    this.root.then(
      new Loop({ bodyTemplate, loopIf: loopCondition, maxIterations }),
    );
    return this;
  }

  loopForever(builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>) {
    return this.loop(builderFn, true);
  }

  conditional(
    condition: (s: Session<TC, TM>) => boolean,
    thenBuilderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    elseBuilderFn?: (agent: Agent<TC, TM>) => Agent<TC, TM>,
  ) {
    const thenAgent = Agent.create<TC, TM>();
    const thenTemplate = thenBuilderFn(thenAgent).build();

    let elseTemplate: Template<TM, TC> | undefined;
    if (elseBuilderFn) {
      const elseAgent = Agent.create<TC, TM>();
      elseTemplate = elseBuilderFn(elseAgent).build();
    }

    this.root.then(
      new Conditional({
        condition: condition,
        thenTemplate: thenTemplate,
        elseTemplate: elseTemplate,
      }),
    );
    return this;
  }

  subroutine(
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    opts?: ISubroutineTemplateOptions<TM, TC>,
  ) {
    const innerAgent = Agent.create<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const subroutineTemplate = builtAgent.build();

    this.root.then(new Subroutine(subroutineTemplate, opts));
    return this;
  }

  sequence(builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>) {
    const innerAgent = Agent.create<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const sequenceTemplate = builtAgent.build();

    this.root.then(sequenceTemplate);
    return this;
  }

  build() {
    return this.root;
  }

  execute(session?: Session<TC, TM> | undefined): Promise<Session<TC, TM>> {
    return this.root.execute(session);
  }
}
