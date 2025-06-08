import { z } from 'zod';
import type { MessageMetadata, Session, SessionContext } from '../session';
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
import { Parallel, ParallelBuilder } from './primitives/parallel';
import { System, type SystemContentInput } from './primitives/system';
import { Transform } from './primitives/transform';
import {
  User,
  type UserContentInput,
  type UserTemplateOptions,
} from './primitives/user';
import { ISubroutineTemplateOptions } from './template_types';

export class Agent<
    TContext extends SessionContext = Record<string, any>,
    TMetadata extends MessageMetadata = Record<string, any>,
  >
  implements Template<TMetadata, TContext>, Fluent<TMetadata, TContext>
{
  private constructor(
    private readonly root: Fluent<TMetadata, TContext> = new Sequence<
      TMetadata,
      TContext
    >(),
  ) {}

  static create<
    TContext extends SessionContext = Record<string, any>,
    TMetadata extends MessageMetadata = Record<string, any>,
  >() {
    return new Agent<TContext, TMetadata>();
  }

  static system<
    TContext extends SessionContext = Record<string, any>,
    TMetadata extends MessageMetadata = Record<string, any>,
  >(contentOrSource: SystemContentInput) {
    return new Agent<TContext, TMetadata>().system(contentOrSource);
  }

  static user<
    TContext extends SessionContext = Record<string, any>,
    TMetadata extends MessageMetadata = Record<string, any>,
  >(content?: UserContentInput, options?: UserTemplateOptions) {
    return new Agent<TContext, TMetadata>().user(content, options);
  }

  static assistant<
    TContext extends SessionContext = Record<string, any>,
    TMetadata extends MessageMetadata = Record<string, any>,
  >(config?: AssistantContentInput, options?: AssistantTemplateOptions) {
    return new Agent<TContext, TMetadata>().assistant(config, options);
  }

  then(t: Template<TMetadata, TContext>) {
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

  /**
   * Extract structured data from LLM response to session variables
   * @param schema - Zod schema defining the structure to extract
   * @param mapping - Where to store the data:
   *   - boolean: Auto-map all schema fields to top-level session vars (overrides existing)
   *   - string: Store entire object in this variable name
   *   - string[]: Extract only specified fields to same-named session vars
   *   - Record<string, string>: Map schema fields to custom variable names
   * @param config - Optional LLM configuration (provider, model, etc.)
   */
  extract(schema: z.ZodType, config?: LLMConfig): this;
  extract(
    schema: z.ZodType,
    mapping: boolean | string | string[] | Record<string, string>,
    config?: LLMConfig,
  ): this;
  extract(
    schema: z.ZodType,
    mappingOrConfig?:
      | boolean
      | string
      | string[]
      | Record<string, string>
      | LLMConfig,
    config?: LLMConfig,
  ): this {
    // Handle parameter overloading: extract(schema, config) vs extract(schema, mapping, config)
    let actualMapping: boolean | string | string[] | Record<string, string>;
    let actualConfig: LLMConfig | undefined;

    if (mappingOrConfig === undefined) {
      // extract(schema) - default to auto-mapping
      actualMapping = true;
      actualConfig = undefined;
    } else if (
      typeof mappingOrConfig === 'object' &&
      !Array.isArray(mappingOrConfig) &&
      ('provider' in mappingOrConfig ||
        'model' in mappingOrConfig ||
        'temperature' in mappingOrConfig)
    ) {
      // extract(schema, config) - mappingOrConfig is LLMConfig
      actualMapping = true; // Default to auto-mapping
      actualConfig = mappingOrConfig as LLMConfig;
    } else {
      // extract(schema, mapping, config?) - mappingOrConfig is mapping
      actualMapping = mappingOrConfig as
        | boolean
        | string
        | string[]
        | Record<string, string>;
      actualConfig = config;
    }

    this.root.then(
      new Assistant(actualConfig, {
        schema,
        mode: 'structured_output',
        extractToVars: actualMapping,
      }),
    );
    return this;
  }

  transform(
    transform: (
      s: Session<TContext, TMetadata>,
    ) => Session<TContext, TMetadata>,
  ) {
    this.root.then(new Transform(transform));
    return this;
  }

  parallel(template: Parallel<TMetadata, TContext>): this;
  parallel(
    configFn: (
      builder: ParallelBuilder<TMetadata, TContext>,
    ) => ParallelBuilder<TMetadata, TContext>,
  ): this;
  parallel(
    templateOrConfig:
      | Parallel<TMetadata, TContext>
      | ((
          builder: ParallelBuilder<TMetadata, TContext>,
        ) => ParallelBuilder<TMetadata, TContext>),
  ): this {
    if (typeof templateOrConfig === 'function') {
      const builder = new ParallelBuilder<TMetadata, TContext>();
      const configuredBuilder = templateOrConfig(builder);
      const config = configuredBuilder.build();
      const parallel = new Parallel<TMetadata, TContext>(config);
      this.root.then(parallel);
    } else {
      this.root.then(templateOrConfig);
    }
    return this;
  }

  loop(
    builderFn: (
      agent: Agent<TContext, TMetadata>,
    ) => Agent<TContext, TMetadata>,
    loopIf: boolean | ((s: Session<TContext, TMetadata>) => boolean),
    maxIterations?: number,
  ) {
    const innerAgent = Agent.create<TContext, TMetadata>();
    const builtAgent = builderFn(innerAgent);
    const bodyTemplate = builtAgent.build();

    const loopCondition = typeof loopIf === 'boolean' ? () => loopIf : loopIf;

    this.root.then(
      new Loop({ bodyTemplate, loopIf: loopCondition, maxIterations }),
    );
    return this;
  }

  loopForever(
    builderFn: (
      agent: Agent<TContext, TMetadata>,
    ) => Agent<TContext, TMetadata>,
  ) {
    return this.loop(builderFn, true);
  }

  conditional(
    condition: (s: Session<TContext, TMetadata>) => boolean,
    thenBuilderFn: (
      agent: Agent<TContext, TMetadata>,
    ) => Agent<TContext, TMetadata>,
    elseBuilderFn?: (
      agent: Agent<TContext, TMetadata>,
    ) => Agent<TContext, TMetadata>,
  ) {
    const thenAgent = Agent.create<TContext, TMetadata>();
    const thenTemplate = thenBuilderFn(thenAgent).build();

    let elseTemplate: Template<TMetadata, TContext> | undefined;
    if (elseBuilderFn) {
      const elseAgent = Agent.create<TContext, TMetadata>();
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
    builderFn: (
      agent: Agent<TContext, TMetadata>,
    ) => Agent<TContext, TMetadata>,
    opts?: ISubroutineTemplateOptions<TMetadata, TContext>,
  ) {
    const innerAgent = Agent.create<TContext, TMetadata>();
    const builtAgent = builderFn(innerAgent);
    const subroutineTemplate = builtAgent.build();

    this.root.then(new Subroutine(subroutineTemplate, opts));
    return this;
  }

  sequence(
    builderFn: (
      agent: Agent<TContext, TMetadata>,
    ) => Agent<TContext, TMetadata>,
  ) {
    const innerAgent = Agent.create<TContext, TMetadata>();
    const builtAgent = builderFn(innerAgent);
    const sequenceTemplate = builtAgent.build();

    this.root.then(sequenceTemplate);
    return this;
  }

  build() {
    return this.root;
  }

  execute(
    session?: Session<TContext, TMetadata> | undefined,
  ): Promise<Session<TContext, TMetadata>> {
    return this.root.execute(session);
  }
}
