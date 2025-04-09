import type { Session } from '../types';
import { createSession } from '../session';
import type { Template, IComposedTemplate, BaseTemplate } from './interfaces';

/**
 * Represents a sequence of templates executed one after another.
 * Used internally by the `then` composition method.
 */
export class ComposedTemplate<
  TStart extends Record<string, unknown> = Record<string, unknown>,
  TEnd extends Record<string, unknown> = TStart,
> implements IComposedTemplate<TStart, TEnd>
{
  constructor(public readonly templates: Template<any, any>[]) {
    if (templates.length === 0) {
      throw new Error('ComposedTemplate must have at least one template.');
    }
  }

  async execute(session?: Session<TStart>): Promise<Session<TEnd>> {
    let currentSession = session || (createSession() as Session<any>); // Start with input type

    for (const template of this.templates) {
      // Execute each template in the sequence
      // Type compatibility is managed by how `then` chains templates
      currentSession = await template.execute(currentSession);
    }

    // The final session will have the output type TEnd
    return currentSession as Session<TEnd>;
  }
}
