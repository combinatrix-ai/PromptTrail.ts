// Export core template interfaces and base classes
export type { Template } from './base';
export { BaseTemplate } from './base';
export { CompositeTemplateBase } from './composite_base';

// Export concrete template implementations
export { System as System } from './system';
export { User as User } from './user';
export { Assistant as Assistant } from './assistant';
export { Conditional as Conditional } from './conditional';
export { Loop as Loop } from './loop';
export { Sequence } from './sequence';
export { Subroutine as Subroutine } from './subroutine';

// Export factory methods
export { TemplateFactory } from './factory';

// Alias Sequence as Agent for backward compatibility
export { Sequence as Agent } from './sequence';
