/**
 * Type definitions for PromptTrail templates
 */

// Template types
export type TemplateType =
  | 'System'
  | 'User'
  | 'Assistant'
  | 'Linear'
  | 'Loop'
  | 'Subroutine';

// Base template interface
export interface ITemplateNode {
  id: string;
  type: TemplateType;
  position: { x: number; y: number };
  data: Record<string, unknown>; // Template-specific data
}

// Specific template interfaces
export interface ISystemTemplateNode extends ITemplateNode {
  type: 'System';
  data: {
    content: string;
  };
}

export interface IUserTemplateNode extends ITemplateNode {
  type: 'User';
  data: {
    description: string;
    default?: string;
    validate?: string; // Function as string
    onInput?: string; // Function as string
  };
}

export interface IAssistantTemplateNode extends ITemplateNode {
  type: 'Assistant';
  data: {
    content?: string;
    model?: string;
  };
}

export interface ILinearTemplateNode extends ITemplateNode {
  type: 'Linear';
  data: {
    childIds: string[]; // IDs of child templates
  };
}

export interface ILoopTemplateNode extends ITemplateNode {
  type: 'Loop';
  data: {
    childIds: string[]; // IDs of child templates
    exitCondition: string; // Function as string
  };
}

export interface ISubroutineTemplateNode extends ITemplateNode {
  type: 'Subroutine';
  data: {
    templateId: string; // ID of the template to execute
    initWith: string; // Function as string
    squashWith?: string; // Function as string
  };
}

// Edge connecting templates
export interface ITemplateEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

// Union type for all template node types
export type TemplateNode =
  | ISystemTemplateNode
  | IUserTemplateNode
  | IAssistantTemplateNode
  | ILinearTemplateNode
  | ILoopTemplateNode
  | ISubroutineTemplateNode;

// Type for the entire template graph
export interface ITemplateGraph {
  nodes: TemplateNode[];
  edges: ITemplateEdge[];
}
