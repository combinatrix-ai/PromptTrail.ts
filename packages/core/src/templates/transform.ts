import type { Session } from '../types';
import { BaseTemplate } from './interfaces';

// Make TTransformFunction generic
export type TTransformFunction<
  T extends Record<string, unknown> = Record<string, unknown>,
> = (session: Session<T>) => Session<any> | Promise<Session<any>>; // Return Session<any> to allow metadata changes

// Make params interface generic
export interface ITransformTemplateParams<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  transformFn: TTransformFunction<T>;
}

/**
 * A template that applies a transformation function to the session.
 * It doesn't add messages directly but modifies the session state (e.g., metadata).
 */
// Make TransformTemplate generic
export class Transform<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends BaseTemplate<T, T> {
  private transformFn: TTransformFunction<T>;

  // Update constructor signature
  constructor(params: ITransformTemplateParams<T> | TTransformFunction<T>) {
    super();
    if (typeof params === 'function') {
      this.transformFn = params;
    } else {
      this.transformFn = params.transformFn;
    }
  }

  // Update execute signature
  async execute(session?: Session<T>): Promise<Session<any>> {
    // Return Session<any>
    const currentSession = this.ensureSession(session);
    // Apply the transformation function
    const updatedSession = await this.transformFn(currentSession);
    // Cast the result back to Session<any> as the transform might have changed metadata type
    return updatedSession as Session<any>;
  }
}
