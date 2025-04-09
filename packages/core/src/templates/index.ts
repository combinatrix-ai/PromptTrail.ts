// Export core template interfaces and base class
export type { Template, IComposedTemplate } from './interfaces';
export { BaseTemplate } from './interfaces';
export { ComposedTemplate } from './composition';

// Export concrete template implementations
export { SystemTemplate } from './system';
export { UserTemplate } from './user';
export { AssistantTemplate } from './assistant';
export { IfTemplate } from './if';
export { LoopTemplate } from './loop';
export { Sequence } from './sequence';

// Export factory methods
export { TemplateFactory } from './factory';

// Alias Sequence as Agent for backward compatibility
export { Sequence as Agent } from './sequence';
