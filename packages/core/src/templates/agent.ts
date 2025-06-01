import type { Session } from '../session';
import { ModelOutput, Source, ValidationOptions } from '../source';
import { Attrs, Vars } from '../tagged_record';
import { IValidator } from '../validators';
import type { Template } from './base';
import { Fluent } from './composite/chainable';
import { Loop } from './composite/loop';
import { Parallel } from './composite/parallel';
import { Sequence } from './composite/sequence';
import { Subroutine } from './composite/subroutine';
import { Assistant } from './primitives/assistant';
import { Conditional } from './primitives/conditional';
import { Structured } from './primitives/structured';
import { System } from './primitives/system';
import { Transform } from './primitives/transform';
import { User } from './primitives/user';
import { ISubroutineTemplateOptions } from './template_types';

/**
 * Agent class for building and executing templates
 * @template TAttrs - The metadata type.
 * @template TVars - The context type.
 * @class
 * @public
 * @remarks
 * This class provides a fluent interface for creating and executing templates,
 * allowing for the addition of system, user, and assistant messages,
 * as well as the ability to define loops and subroutines.
 * It serves as a builder for complex template compositions.
 * The templates can be executed in a sequence or as part of a subroutine,
 * enabling flexible and reusable template structures.
 * The class also supports the addition of custom exit conditions for loops
 * and the ability to retain messages or isolate context in subroutines.
 * The Agent class is designed to be extensible and customizable,
 * allowing developers to create sophisticated conversational agents
 * with complex logic and context management.
 * It is a key component of the template system, enabling the creation
 * of dynamic and interactive conversational experiences.
 * @example
 * const agent = Agent.create()
 *   .system('System message')
 *   .user('User message')
 *   .assistant('Assistant message')
 *   .loop(agent => agent.user('Input'), condition)
 *   .subroutine(agent => agent.user('Sub'));
 */
export class Agent<TC extends Vars = Vars, TM extends Attrs = Attrs>
  implements Template<TM, TC>, Fluent<TM, TC>
{
  private constructor(
    private readonly root: Fluent<TM, TC> = new Sequence<TM, TC>(),
  ) {}

  /** Static factory methods -------------------------------------------------- */

  static create<TC extends Vars = Vars, TM extends Attrs = Attrs>() {
    return new Agent<TC, TM>();
  }

  static system<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    content: string,
  ) {
    return new Agent<TC, TM>().system(content);
  }

  static user<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    contentOrSource?: string | Source<string>,
  ) {
    return new Agent<TC, TM>().user(contentOrSource);
  }

  static assistant<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    contentOrSource?: string | Source<ModelOutput> | Source<string>,
    validatorOrOptions?: IValidator | ValidationOptions,
  ) {
    return new Agent<TC, TM>().assistant(contentOrSource, validatorOrOptions);
  }

  /** fluent helpers -------------------------------------------------- */

  add(t: Template<TM, TC>) {
    this.root.add(t);
    return this;
  }

  system(content: string) {
    this.root.add(new System(content));
    return this;
  }

  user(contentOrSource?: string | Source<string>) {
    this.root.add(new User(contentOrSource));
    return this;
  }

  assistant(
    contentOrSource?: string | Source<ModelOutput> | Source<string>,
    validatorOrOptions?: IValidator | ValidationOptions,
  ) {
    this.root.add(new Assistant(contentOrSource, validatorOrOptions));
    return this;
  }

  transform(transform: (s: Session<TC, TM>) => Session<TC, TM>) {
    this.root.add(new Transform(transform));
    return this;
  }

  parallel(template: Parallel<TM, TC>) {
    this.root.add(template);
    return this;
  }

  structured(template: Structured<TM, TC>) {
    this.root.add(template);
    return this;
  }

  /** Function-based template builders -------------------------------------------------- */

  loop(
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    loopIf: boolean | ((s: Session<TC, TM>) => boolean),
    maxIterations?: number,
  ) {
    const innerAgent = Agent.create<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const bodyTemplate = builtAgent.build();

    const loopCondition = typeof loopIf === 'boolean' ? () => loopIf : loopIf;

    this.root.add(
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

    this.root.add(
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

    this.root.add(new Subroutine(subroutineTemplate, opts));
    return this;
  }

  sequence(builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>) {
    const innerAgent = Agent.create<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const sequenceTemplate = builtAgent.build();

    this.root.add(sequenceTemplate);
    return this;
  }

  /** -------------------------------------------------- */

  build() {
    return this.root;
  }

  execute(session?: Session<TC, TM> | undefined): Promise<Session<TC, TM>> {
    if (session) {
      return this.root.execute(session);
    } else {
      return this.root.execute();
    }
  }
}
