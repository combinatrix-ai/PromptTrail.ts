import type { Template } from './base';
import { Loop } from './composite/loop';
import { Sequence } from './composite/sequence';
import { Subroutine } from './composite/subroutine';
import { System } from './primitives/system';
import { User } from './primitives/user';
import { Assistant } from './primitives/assistant';
import type { Session } from '../session';
import { Metadata, Context } from '../taggedRecord';
import { ISubroutineTemplateOptions } from './template_types';

type ChainableTemplate<
  TMetadata extends Metadata,
  TContext extends Context,
> = Template<TMetadata, TContext> & {
  add(t: Template<TMetadata, TContext>): any;
  execute(
    s?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>>;
};

/**
 * Agent class for building and executing templates
 * @template TMetadata - The metadata type.
 * @template TContext - The context type.
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
export class Agent<TM extends Metadata = Metadata, TC extends Context = Context>
  implements Template<TM, TC>
{
  constructor(
    private readonly root: ChainableTemplate<TM, TC> = new Sequence<TM, TC>(),
  ) {}

  /** fluent helpers -------------------------------------------------- */

  addSystem(content: string) {
    this.root.add(new System(content));
    return this;
  }
  addUser(content: string) {
    this.root.add(new User(content));
    return this;
  }
  addAssistant(content: string) {
    this.root.add(new Assistant(content));
    return this;
  }

  addLoop(body: Template<TM, TC>, exit: (s: Session<TC, TM>) => boolean) {
    this.root.add(new Loop({ bodyTemplate: body, exitCondition: exit }));
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
