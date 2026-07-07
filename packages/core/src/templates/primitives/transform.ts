import type { Session, Vars } from '../../session';
import { TemplateBase } from '../base';
import type { TransformFn } from '../template_types';

/**
 * A template that applies a transformation function to the session.
 * It doesn't add messages directly but modifies the session state (e.g., metadata).
 */
export class Transform<TVars extends Vars = Vars> extends TemplateBase<TVars> {
  private transformFn: TransformFn<TVars>;

  // Update constructor signature
  constructor(fn: TransformFn<TVars> | TransformFn<TVars>[]) {
    super();
    // Higher-order function
    if (Array.isArray(fn)) {
      this.transformFn = (session: Session<TVars>) => {
        let updatedSession = session;
        for (const f of fn) {
          updatedSession = f(updatedSession);
        }
        return updatedSession;
      };
    } else if (typeof fn === 'function') {
      this.transformFn = fn;
    } else {
      throw new Error('Invalid transform function');
    }
  }

  /**
   * @internal
   */
  getTransformFn(): TransformFn<TVars> {
    return this.transformFn;
  }

  getManifestDescriptor() {
    return {
      kind: 'template',
      templateType: 'Transform',
      transform: this.transformFn,
    };
  }

  async execute(session?: Session<TVars>): Promise<Session<TVars>> {
    const currentSession = this.ensureSession(session);
    return this.transformFn(currentSession);
  }
}
