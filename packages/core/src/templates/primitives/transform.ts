import type { Session } from '../../session';
import { Context, Metadata } from '../../tagged_record';
import { TemplateBase } from '../base';
import type { TransformFn } from '../template_types';

/**
 * A template that applies a transformation function to the session.
 * It doesn't add messages directly but modifies the session state (e.g., metadata).
 */
// Make TransformTemplate generic
export class Transform<
  TMetadata extends Metadata = Metadata,
  TContext extends Context = Context,
> extends TemplateBase<TMetadata, TContext> {
  private transformFn: TransformFn<TMetadata, TContext>;

  // Update constructor signature
  constructor(
    fn: TransformFn<TMetadata, TContext> | TransformFn<TMetadata, TContext>[],
  ) {
    super();
    // Higher-order function
    if (Array.isArray(fn)) {
      this.transformFn = async (session: Session<TContext, TMetadata>) => {
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
    session?: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>> {
    // Return Session<any>
    const currentSession = this.ensureSession(session);
    // Apply the transformation function
    const updatedSession = await this.transformFn(currentSession);
    // Cast the result back to Session<TContext, TMetadata> as the transform might have changed metadata type
    return updatedSession as Session<TContext, TMetadata>;
  }
}
