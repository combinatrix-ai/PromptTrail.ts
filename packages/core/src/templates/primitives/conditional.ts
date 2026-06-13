import type { Session, Vars } from '../../session';
import type { ExecutionRuntimeState } from '../../interceptors';
import type { Template } from '../base';
import { TemplateBase } from '../base';

export class Conditional<
  TVars extends Vars = Vars,
> extends TemplateBase<TVars> {
  private condition: (session: Session<TVars>) => boolean;
  private thenTemplate: Template<TVars>;
  private elseTemplate?: Template<TVars>;

  constructor(options: {
    condition: (session: Session<TVars>) => boolean;
    thenTemplate: Template<TVars>;
    elseTemplate?: Template<TVars>;
  }) {
    super();
    this.condition = options.condition;
    this.thenTemplate = options.thenTemplate;
    this.elseTemplate = options.elseTemplate;
  }

  /**
   * @internal
   */
  getCondition(): (session: Session<TVars>) => boolean {
    return this.condition;
  }

  /**
   * @internal
   */
  getThenTemplate(): Template<TVars> {
    return this.thenTemplate;
  }

  /**
   * @internal
   */
  getElseTemplate(): Template<TVars> | undefined {
    return this.elseTemplate;
  }

  getManifestDescriptor() {
    return {
      kind: 'template',
      templateType: 'Conditional',
      condition: this.condition,
      thenTemplate: this.thenTemplate,
      elseTemplate: this.elseTemplate,
    };
  }

  async execute(
    session?: Session<TVars>,
    runtime?: ExecutionRuntimeState<TVars>,
  ): Promise<Session<TVars>> {
    const validSession = this.ensureSession(session);

    if (this.condition(validSession)) {
      return this.thenTemplate.execute(validSession, runtime);
    } else if (this.elseTemplate) {
      return this.elseTemplate.execute(validSession, runtime);
    }
    return validSession; // Return unchanged session if condition is false and no else branch
  }
}
