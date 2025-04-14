import type { Session } from '../types';
import { BaseTemplate } from './interfaces';
import type { Template } from './interfaces';

export class LoopTemplate extends BaseTemplate<any, any> {
  private bodyTemplate: Template<any, any>;
  private exitCondition: (session: Session) => boolean;
  private maxIterations: number;

  constructor(options: {
    bodyTemplate: Template<any, any>;
    exitCondition: (session: Session) => boolean;
    maxIterations?: number;
  }) {
    super();
    this.bodyTemplate = options.bodyTemplate;
    this.exitCondition = options.exitCondition;
    this.maxIterations = options.maxIterations ?? 100; // Default to 100 iterations
  }

  async execute(session?: Session): Promise<Session> {
    let currentSession = this.ensureSession(session);
    let iterations = 0;

    // Original simple while loop
    while (
      iterations < this.maxIterations &&
      !this.exitCondition(currentSession)
    ) {
      currentSession = await this.bodyTemplate.execute(currentSession);
      iterations++;
    }

    if (iterations >= this.maxIterations) {
      console.warn(
        `LoopTemplate reached maximum iterations (${this.maxIterations}). Exiting.`,
      );
      // Optionally, you could throw an error instead:
      // throw new Error(`LoopTemplate reached maximum iterations (${this.maxIterations}).`);
    }

    return currentSession;
  }
}
