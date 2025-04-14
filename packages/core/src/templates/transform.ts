import type { Session } from '../types';
import { BaseTemplate } from './interfaces';

export type TTransformFunction = (session: Session) => Session | Promise<Session>;

export interface ITransformTemplateParams {
  transformFn: TTransformFunction;
}

/**
 * A template that applies a transformation function to the session.
 * It doesn't add messages directly but modifies the session state (e.g., metadata).
 */
export class TransformTemplate extends BaseTemplate<Record<string, unknown>, Record<string, unknown>> {
  private transformFn: TTransformFunction;

  constructor(params: ITransformTemplateParams | TTransformFunction) {
    super();
    if (typeof params === 'function') {
      this.transformFn = params;
    } else {
      this.transformFn = params.transformFn;
    }
  }

  async execute(session?: Session<Record<string, unknown>>): Promise<Session<Record<string, unknown>>> {
    const currentSession = this.ensureSession(session); // ensureSession now correctly expects Session<Record<string, unknown>> | undefined
    // Apply the transformation function
    // transformFn expects Session<Record<string, unknown>> and currentSession is Session<Record<string, unknown>>
    const updatedSession = await this.transformFn(currentSession);
    return updatedSession;
  }
}