/**
 * Migration utilities
 * 
 * This file is kept for backward compatibility but the model-specific
 * migration functions have been removed as part of the transition to
 * using generateOptions directly.
 */

// Export a dummy function to make this a proper module
export function createMigrationOptions(options: Record<string, unknown>): Record<string, unknown> {
  return { ...options };
}
