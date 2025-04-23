/**
 * Base error class for all PromptTrail errors
 */
export class PromptTrailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptTrailError';
  }
}

/**
 * Error thrown when validation fails
 */
export class ValidationError extends PromptTrailError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
