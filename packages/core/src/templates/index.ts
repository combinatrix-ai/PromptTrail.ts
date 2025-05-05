// Export core template interfaces and base classes
export type { Template } from './base';
export { TemplateBase } from './base';
export { Composite } from './composite/composite';

// Export concrete template implementations
export { System } from './primitives/system';
export { User } from './primitives/user';
export { Assistant } from './primitives/assistant';
export { Conditional } from './primitives/conditional';
export { Transform } from './primitives/transform';
export { Structured } from './primitives/structured';
export { Loop } from './composite/loop';
export { Sequence } from './composite/sequence';
export { Subroutine } from './composite/subroutine';

// Export Agent (Template Builder)
export { Agent } from './agent';
