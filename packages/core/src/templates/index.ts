// Export core template interfaces and base classes
export { TemplateBase } from './base';
export type { Template } from './base';
export { Composite } from './composite/composite';

// Export concrete template implementations
export { Loop } from './composite/loop';
export { Parallel } from './composite/parallel';
export { Sequence } from './composite/sequence';
export { Subroutine } from './composite/subroutine';
export { Assistant } from './primitives/assistant';
export { Conditional } from './primitives/conditional';
export { Structured } from './primitives/structured';
export { System } from './primitives/system';
export { Transform } from './primitives/transform';
export { User } from './primitives/user';

// Export Agent (Template Builder)
export { Agent } from './agent';

// Export Scenario API
export {
  Scenario,
  StepTemplates,
  Scenarios,
  isInteractiveStep,
} from './scenario';
export type {
  StepOptions,
  InteractiveStepOptions,
  NonInteractiveStepOptions,
  ScenarioConfig,
} from './scenario';

// Export Parallel template types
export type {
  ScoringFunction,
  AggregationStrategy,
  BuiltInStrategy,
  Strategy,
} from './composite/parallel';
