import type { Session } from '../types'; // Imports the generic Session type
import { BaseTemplate } from './interfaces';
import type { Template } from './interfaces';

// Make LoopTemplate generic over the metadata type T
export class LoopTemplate<
  T extends Record<string, unknown> = Record<string, unknown>,
> extends BaseTemplate<any, any> { // BaseTemplate generics might need review later
  // TODO: Review if Template<any, any> is correct or needs T
  private bodyTemplate: Template<any, any>;
  private exitCondition: (session: Session<T>) => boolean; // Use Session<T>
  private maxIterations: number;

  // Update constructor signature to use Session<T>
  constructor(options: {
    bodyTemplate: Template<any, any>;
    exitCondition: (session: Session<T>) => boolean;
    maxIterations?: number;
  }) {
    super();
    this.bodyTemplate = options.bodyTemplate;
    this.exitCondition = options.exitCondition;
    this.maxIterations = options.maxIterations ?? 100; // Default to 100 iterations
  }

  // Update execute signature to use Session<T>
  async execute(session?: Session<T>): Promise<Session<T>> {
    // Assuming ensureSession can handle or infer T, or needs update
    let currentSession = this.ensureSession(session) as Session<T>; // Cast for now, review ensureSession later
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
