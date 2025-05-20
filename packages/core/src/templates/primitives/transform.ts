import type { Session } from '../../session';
import { Attrs, Vars } from '../../tagged_record';
import { TemplateBase } from '../base';
import type { TransformFn } from '../template_types';

/**
 * A template that applies a transformation function to the session.
 * It doesn't add messages directly but modifies the session state (e.g., metadata).
 */
// Make TransformTemplate generic
export class Transform<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends TemplateBase<TAttrs, TVars> {
  private transformFn: TransformFn<TAttrs, TVars>;

  // Update constructor signature
  constructor(fn: TransformFn<TAttrs, TVars> | TransformFn<TAttrs, TVars>[]) {
    super();
    // Higher-order function
    if (Array.isArray(fn)) {
      this.transformFn = async (session: Session<TVars, TAttrs>) => {
        let updatedSession = session;
        for (const f of fn) {
          updatedSession = await f(updatedSession);
        }
        return updatedSession;
      };
    } else if (typeof fn === 'function') {
      this.transformFn = fn;
    } else {
      throw new Error('Invalid transform function');
    }
  }

  // Update execute signature
  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    // Return Session<any>
    const currentSession = this.ensureSession(session);
    // Apply the transformation function
    const updatedSession = await this.transformFn(currentSession);
    // Cast the result back to Session<TVars, TAttrs> as the transform might have changed metadata type
    return updatedSession as Session<TVars, TAttrs>;
  }
}
