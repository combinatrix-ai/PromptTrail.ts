import type { Session } from '../../session';
import { BaseTemplate } from '../base';
import { ITransformTemplateParams } from '../template_types';
import type { TTransformFunction } from '../template_types';
import { Metadata, Context } from '../../taggedRecord';

/**
 * A template that applies a transformation function to the session.
 * It doesn't add messages directly but modifies the session state (e.g., metadata).
 */
// Make TransformTemplate generic
export class Transform<
  TMetadata extends Metadata,
  TContext extends Context,
> extends BaseTemplate<TMetadata, TContext> {
  private transformFn: TTransformFunction<TMetadata, TContext>;

  // Update constructor signature
  constructor(
    params:
      | ITransformTemplateParams<TMetadata, TContext>
      | TTransformFunction<TMetadata, TContext>,
  ) {
    super();
    if (typeof params === 'function') {
      this.transformFn = params;
    } else {
      this.transformFn = params.transformFn;
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
