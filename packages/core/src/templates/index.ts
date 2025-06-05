// Export core template interfaces and base classes
export { TemplateBase } from './base';
export type { Template } from './base';
export { Composite } from './composite/composite';

// Export concrete template implementations
export { Loop } from './composite/loop';
export { Sequence } from './composite/sequence';
export { Subroutine } from './composite/subroutine';
export { Assistant } from './primitives/assistant';
export { Conditional } from './primitives/conditional';
export { Parallel } from './primitives/parallel';
export { System } from './primitives/system';
export { Transform } from './primitives/transform';
export { User } from './primitives/user';

// Export Agent (Template Builder)
export { Agent } from './agent';

// Export Scenario API
export {
  isInteractiveStep,
  Scenario,
  Scenarios,
  StepTemplates,
} from './scenario';
export type {
  InteractiveStepOptions,
  NonInteractiveStepOptions,
  ScenarioConfig,
  StepOptions,
} from './scenario';

// Export Parallel template types
export type {
  AggregationStrategy,
  BuiltInStrategy,
  ScoringFunction,
  Strategy,
} from './primitives/parallel';
