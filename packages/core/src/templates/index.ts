// Export core template interfaces and base class
export type { Template, IComposedTemplate } from './interfaces';
export { BaseTemplate } from './interfaces';
export { Composed as ComposedTemplate } from './composition';

// Export concrete template implementations
export { System as SystemTemplate } from './system';
export { User as UserTemplate } from './user';
export { Assistant as AssistantTemplate } from './assistant';
export { Conditional as IfTemplate } from './conditional';
export { Loop as LoopTemplate } from './loop';
export { Sequence } from './sequence';
export { Subroutine as SubroutineTemplate } from './subroutine';

// Export factory methods
export { TemplateFactory } from './factory';

// Alias Sequence as Agent for backward compatibility
export { Sequence as Agent } from './sequence';
