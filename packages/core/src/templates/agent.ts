import type { Session } from '../session';
import { ModelOutput, Source, ValidationOptions } from '../source';
import { Attrs, Vars } from '../tagged_record';
import { IValidator } from '../validators';
import type { Template } from './base';
import { Fluent } from './composite/chainable';
import { Loop } from './composite/loop';
import { Sequence } from './composite/sequence';
import { Subroutine } from './composite/subroutine';
import { Assistant } from './primitives/assistant';
import { Conditional } from './primitives/conditional';
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
 * const agent = new Agent()
 *   .addSystem('System message')
 *   .addUser('User message')
 *   .addAssistant('Assistant message')
 *   .addLoop(userInput => userInput !== 'exit', userInputTemplate)
 *   .addSubroutine(subroutineTemplate);
 */
export class Agent<TC extends Vars = Vars, TM extends Attrs = Attrs>
  implements Template<TM, TC>, Fluent<TM, TC>
{
  constructor(private readonly root: Fluent<TM, TC> = new Sequence<TM, TC>()) {}

  /** Static factory methods -------------------------------------------------- */

  static create<TC extends Vars = Vars, TM extends Attrs = Attrs>() {
    return new Agent<TC, TM>();
  }

  static system<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    content: string,
  ) {
    return new Agent<TC, TM>().addSystem(content);
  }

  static user<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    contentOrSource?: string | Source<string>,
  ) {
    return new Agent<TC, TM>().addUser(contentOrSource);
  }

  static assistant<TC extends Vars = Vars, TM extends Attrs = Attrs>(
    contentOrSource?: string | Source<ModelOutput> | Source<string>,
    validatorOrOptions?: IValidator | ValidationOptions,
  ) {
    return new Agent<TC, TM>().addAssistant(
      contentOrSource,
      validatorOrOptions,
    );
  }

  /** fluent helpers -------------------------------------------------- */

  add(t: Template<TM, TC>) {
    this.root.add(t);
    return this;
  }

  addSystem(content: string) {
    this.root.add(new System(content));
    return this;
  }

  system(content: string) {
    return this.addSystem(content);
  }

  addUser(contentOrSource?: string | Source<string>) {
    this.root.add(new User(contentOrSource));
    return this;
  }

  user(contentOrSource?: string | Source<string>) {
    return this.addUser(contentOrSource);
  }

  addAssistant(
    contentOrSource?: string | Source<ModelOutput> | Source<string>,
    validatorOrOptions?: IValidator | ValidationOptions,
  ) {
    this.root.add(new Assistant(contentOrSource, validatorOrOptions));
    return this;
  }

  assistant(
    contentOrSource?: string | Source<ModelOutput> | Source<string>,
    validatorOrOptions?: IValidator | ValidationOptions,
  ) {
    return this.addAssistant(contentOrSource, validatorOrOptions);
  }

  addConditional(
    condition: (s: Session<TC, TM>) => boolean,
    thenTemplate: Template<TM, TC>,
    elseTemplate?: Template<TM, TC>,
  ) {
    this.root.add(
      new Conditional({
        condition: condition,
        thenTemplate: thenTemplate,
        elseTemplate: elseTemplate,
      }),
    );
    return this;
  }

  addTransform(transform: (s: Session<TC, TM>) => Session<TC, TM>) {
    this.root.add(new Transform(transform));
    return this;
  }

  addLoop(body: Template<TM, TC>, loopIf: (s: Session<TC, TM>) => boolean) {
    this.root.add(new Loop({ bodyTemplate: body, loopIf: loopIf }));
    return this;
  }

  addSubroutine(
    tpl: Template<TM, TC> | Template<TM, TC>[],
    opts?: ISubroutineTemplateOptions<TM, TC>,
  ) {
    this.root.add(new Subroutine(tpl, opts));
    return this;
  }

  addSequence(parts: Template<TM, TC>[]) {
    this.root.add(new Sequence(parts));
    return this;
  }

  /** Function-based template builders -------------------------------------------------- */

  loop(
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    loopIf: boolean | ((s: Session<TC, TM>) => boolean),
    maxIterations?: number,
  ) {
    const innerAgent = new Agent<TC, TM>();
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

  subroutine(
    builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>,
    opts?: ISubroutineTemplateOptions<TM, TC>,
  ) {
    const innerAgent = new Agent<TC, TM>();
    const builtAgent = builderFn(innerAgent);
    const subroutineTemplate = builtAgent.build();

    this.root.add(new Subroutine(subroutineTemplate, opts));
    return this;
  }

  sequence(builderFn: (agent: Agent<TC, TM>) => Agent<TC, TM>) {
    const innerAgent = new Agent<TC, TM>();
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
