import { create } from 'zustand';
import { nanoid } from 'nanoid';

// Template type definitions
export type TemplateType =
  | 'System'
  | 'User'
  | 'Assistant'
  | 'Linear'
  | 'Loop'
  | 'Subroutine';

// Base template interface
export interface TemplateNode {
  id: string;
  type: TemplateType;
  parentId?: string;
  position: number; // Order within parent
  data: Record<string, string | number | boolean | string[] | undefined>;
}

// Specific template interfaces
export interface SystemTemplateNode extends TemplateNode {
  type: 'System';
  data: {
    content: string;
  };
}

export interface UserTemplateNode extends TemplateNode {
  type: 'User';
  data: {
    description: string;
    default?: string;
    inputType?: 'runtime' | 'fixed';
    validate?: string; // Function as string
    onInput?: string; // Function as string
  };
}

export interface AssistantTemplateNode extends TemplateNode {
  type: 'Assistant';
  data: {
    assistantType?: 'model' | 'content';
    content?: string;
    model?: string;
  };
}

export interface LinearTemplateNode extends TemplateNode {
  type: 'Linear';
  data: {
    name?: string;
    [key: string]: string | number | boolean | string[] | undefined; // Allow other properties
  };
}

export interface LoopTemplateNode extends TemplateNode {
  type: 'Loop';
  data: {
    name?: string;
    exitCondition: string; // Function as string
  };
}

export interface SubroutineTemplateNode extends TemplateNode {
  type: 'Subroutine';
  data: {
    name?: string;
    childIds?: string[]; // IDs of child templates
    templateId?: string; // ID of the template to execute (legacy support)
    initWith: string; // Function as string
    squashWith?: string; // Function as string
  };
}

// Store interface
interface TemplateStore {
  templates: TemplateNode[];
  selectedId: string | null;

  // Actions
  addTemplate: (
    parentId: string | null,
    type: TemplateType,
    position?: number,
  ) => string;
  updateTemplate: (id: string, data: Partial<TemplateNode>) => void;
  removeTemplate: (id: string) => void;
  selectTemplate: (id: string | null) => void;
  moveTemplate: (id: string, newPosition: number) => void;

  // Helpers
  getRootTemplate: () => TemplateNode | undefined;
  getChildTemplates: (parentId: string) => TemplateNode[];
  generateCode: () => string;
  loadFromCode: (code: string) => void;
  resetStore: () => void;
}

// Initial template data when creating a new visualizer
const createInitialTemplate = (): TemplateNode[] => {
  const rootId = nanoid(6);
  const systemId = nanoid(6);

  return [
    {
      id: rootId,
      type: 'Linear',
      position: 0,
      data: {
        name: 'chatTemplate',
      },
    },
    {
      id: systemId,
      type: 'System',
      parentId: rootId,
      position: 0,
      data: {
        content:
          'You are a helpful AI assistant. Be concise and friendly in your responses.',
      },
    },
  ];
};

// Create the template store
export const useTemplateStore = create<TemplateStore>((set, get) => ({
  templates: createInitialTemplate(),
  selectedId: null,

  // Add a new template
  addTemplate: (parentId, type, position) => {
    const templates = get().templates;

    // Check if parent exists or if null, assume root
    let parent: TemplateNode | undefined;
    if (parentId) {
      parent = templates.find((t) => t.id === parentId);
      if (!parent) {
        throw new Error(`Parent template with ID ${parentId} not found`);
      }

      // Check if parent can have children
      if (
        parent.type !== 'Linear' &&
        parent.type !== 'Loop' &&
        parent.type !== 'Subroutine'
      ) {
        throw new Error(`Template type ${parent.type} cannot have children`);
      }

      // Enforce System template to be at the top of its parent
      if (type === 'System') {
        // Get children of this parent
        const children = get().getChildTemplates(parentId);

        // Check if there are existing children
        if (children.length > 0) {
          // Check if we're not placing it at the top position
          if (position !== 0 && position !== undefined) {
            // Exception: Allow System template to be placed anywhere within a SubroutineTemplate
            const parentTemplate = templates.find((t) => t.id === parentId);
            if (parentTemplate?.type !== 'Subroutine') {
              throw new Error(
                'System template must be placed at the top of its container',
              );
            }
          }
        }

        // Further check: If the parent itself is nested, make sure it doesn't violate the rule
        // by having a System template not at the very top of all containers
        // (allowing patterns like Linear(Loop(Loop(System))) but not Linear(User, Loop(System)))
        if (position === 0 || position === undefined) {
          // Check the parent hierarchy to ensure we don't violate the System template position rule
          let isValidPosition = true;

          // Helper function to check parent hierarchy
          const checkParentHierarchy = (templateId: string): boolean => {
            const template = templates.find((t) => t.id === templateId);
            if (!template || !template.parentId) return true;

            const parentId = template.parentId;
            const siblings = get().getChildTemplates(parentId);

            // If this template is not at position 0 within its parent's children
            if (template.position !== 0 && siblings.length > 0) {
              const parentTemplate = templates.find((t) => t.id === parentId);

              // Allow exceptions for control templates
              if (parentTemplate && parentTemplate.type !== 'Subroutine') {
                return false;
              }
            }

            // Continue checking up the hierarchy
            return checkParentHierarchy(parentId);
          };

          isValidPosition = checkParentHierarchy(parentId);

          if (!isValidPosition) {
            throw new Error(
              'System template must be at the top of all nested containers',
            );
          }
        }
      }
    }

    // Create a new unique ID
    const id = nanoid(6);

    // Calculate position if not provided
    const pos =
      position !== undefined
        ? position
        : parent
          ? get().getChildTemplates(parentId!).length
          : 0;

    // Create base template data
    const newTemplate: TemplateNode = {
      id,
      type,
      parentId: parentId ?? undefined,
      position: pos,
      data: {},
    };

    // Calculate default name for container templates
    let defaultName = '';
    if (['Linear', 'Loop', 'Subroutine'].includes(type)) {
      // Count existing templates of this type
      const typeCount = templates.filter((t) => t.type === type).length + 1;

      // Set specific default names
      if (type === 'Linear' && !parentId) {
        // Root linear template
        defaultName = 'chatTemplate';
      } else {
        // Non-root templates
        const typeLower = type.toLowerCase();
        defaultName = `${typeLower}Template${typeCount}`;
      }
    }

    // Add type-specific defaults
    switch (type) {
      case 'System': {
        (newTemplate as SystemTemplateNode).data = {
          content: 'System content',
        };
        break;
      }
      case 'User': {
        (newTemplate as UserTemplateNode).data = {
          description: 'Your message:',
          default: '',
          inputType: 'runtime', // Default to runtime input
        };
        break;
      }
      case 'Assistant': {
        (newTemplate as AssistantTemplateNode).data = {
          assistantType: 'model',
          model: 'gpt-4o-mini',
        };
        break;
      }
      case 'Loop': {
        (newTemplate as LoopTemplateNode).data = {
          name: defaultName,
          exitCondition:
            '(session) => {\n  // Exit condition\n  return false;\n}',
        };
        break;
      }
      case 'Linear': {
        (newTemplate as LinearTemplateNode).data = {
          name: defaultName,
        };
        break;
      }
      case 'Subroutine': {
        (newTemplate as SubroutineTemplateNode).data = {
          name: defaultName,
          childIds: [],
          templateId: '',
          initWith: '(session) => ({})',
        };
        break;
      }
    }

    // Update the templates array
    set({
      templates: [...templates, newTemplate],
      selectedId: id, // Select the new template
    });

    return id;
  },

  // Update an existing template
  updateTemplate: (id, data) => {
    set((state) => ({
      templates: state.templates.map((template) =>
        template.id === id
          ? { ...template, ...data, data: { ...template.data, ...data.data } }
          : template,
      ),
    }));
  },

  // Remove a template and its children
  removeTemplate: (id) => {
    const templates = get().templates;

    // Don't allow removing the root template under any circumstances
    const rootTemplate = get().getRootTemplate();
    if (rootTemplate && rootTemplate.id === id) {
      console.warn('Cannot remove the root LinearTemplate');
      return;
    }

    const template = templates.find((t) => t.id === id);
    if (!template) {
      return;
    }

    // Get all descendant IDs (recursive)
    const getDescendantIds = (templateId: string): string[] => {
      const children = templates.filter((t) => t.parentId === templateId);
      const childIds = children.map((c) => c.id);
      const descendantIds = childIds.flatMap((cId) => getDescendantIds(cId));
      return [...childIds, ...descendantIds];
    };

    const idsToRemove = [id, ...getDescendantIds(id)];

    // Update positions of siblings
    const siblings = templates
      .filter((t) => t.parentId === template.parentId && t.id !== id)
      .sort((a, b) => a.position - b.position);

    const updatedSiblings = siblings.map((sibling, idx) => ({
      ...sibling,
      position: idx,
    }));

    // Create updated templates array
    const remainingTemplates = templates
      .filter((t) => !idsToRemove.includes(t.id))
      .map((t) => {
        const updated = updatedSiblings.find((s) => s.id === t.id);
        return updated || t;
      });

    set({
      templates: remainingTemplates,
      selectedId: template.parentId || null,
    });
  },

  // Select a template
  selectTemplate: (id) => {
    set({ selectedId: id });
  },

  // Move a template to a new position within its parent
  moveTemplate: (id, newPosition) => {
    const templates = get().templates;
    const template = templates.find((t) => t.id === id);

    if (!template) {
      return;
    }

    const parentId = template.parentId;
    const siblings = templates
      .filter((t) => t.parentId === parentId)
      .sort((a, b) => a.position - b.position);

    // Ensure the new position is valid
    const maxPosition = siblings.length - 1;
    const validPosition = Math.max(0, Math.min(newPosition, maxPosition));

    // No change needed if the position is the same
    if (validPosition === template.position) {
      return;
    }

    // Reorder the siblings
    const newSiblings = [...siblings];
    newSiblings.splice(template.position, 1); // Remove from current position
    newSiblings.splice(validPosition, 0, template); // Insert at new position

    // Update positions
    const updatedSiblings = newSiblings.map((sibling, idx) => ({
      ...sibling,
      position: idx,
    }));

    // Update the templates array
    set({
      templates: templates.map((t) => {
        const updated = updatedSiblings.find((s) => s.id === t.id);
        return updated || t;
      }),
    });
  },

  // Get the root template (should be a Linear template)
  getRootTemplate: () => {
    const templates = get().templates;
    return templates.find((t) => !t.parentId);
  },

  // Get child templates of a parent, sorted by position
  getChildTemplates: (parentId) => {
    const templates = get().templates;
    return templates
      .filter((t) => t.parentId === parentId)
      .sort((a, b) => a.position - b.position);
  },

  // Generate code representation of the templates
  generateCode: () => {
    const templates = get().templates;
    if (templates.length === 0) {
      return `import { LinearTemplate } from '@prompttrail/core';\n\nconst chatTemplate = new LinearTemplate();\n\nexport default chatTemplate;\n`;
    }

    console.log('Generating code for templates:', templates);

    // Start with imports
    let code = `import {\n`;
    const usedTypes = new Set(templates.map((t) => t.type));
    for (const type of usedTypes) {
      code += `  ${type}Template,\n`;
    }
    code += `} from '@prompttrail/core';\n`;

    // Add import for customInputSource if we have User templates with runtime input
    const hasRuntimeUserTemplates = templates.some(
      (t) => t.type === 'User' && t.data.inputType === 'runtime',
    );
    if (hasRuntimeUserTemplates) {
      code += `import { customInputSource } from './customInputSource';\n`;
    }

    code += `\n`;

    // Track variable names for each template
    const varNames = new Map<string, string>();
    const typeCounts: Record<string, number> = {};

    // Assign variable names with consistent naming conventions
    templates.forEach((template) => {
      const type = template.type.toLowerCase();
      typeCounts[type] = (typeCounts[type] || 0) + 1;

      let varName: string;

      // Root linear template is always 'chatTemplate'
      if (type === 'linear' && !template.parentId) {
        varName = 'chatTemplate';
      }
      // Named templates - convert name to valid variable name
      else if (
        template.data.name &&
        ['linear', 'loop', 'subroutine'].includes(type)
      ) {
        // Convert the name to a valid JavaScript variable name
        const validName = String(template.data.name)
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .replace(/^[0-9]/, '_'); // Ensure the name doesn't start with a number

        // Check if this name is already used
        let uniqueName = validName;
        let count = 1;
        while ([...varNames.values()].includes(uniqueName)) {
          uniqueName = `${validName}${count}`;
          count++;
        }

        varName = uniqueName;
      }
      // Default naming convention for unnamed templates
      else {
        // For unnamed templates, use consistent naming:
        // linearTemplate1, loopTemplate1, subroutineTemplate1, etc.
        varName = `${type}Template${typeCounts[type]}`;
      }

      varNames.set(template.id, varName);
    });

    // Helper function to generate template code
    const generateTemplateCode = (template: TemplateNode): string => {
      const varName = varNames.get(template.id) || 'template';
      const children = get().getChildTemplates(template.id);

      // Helper function to handle multi-line strings
      function formatString(str: string): string {
        if (!str) return '';

        // Check if the string contains newlines
        if (str.includes('\n')) {
          // Use template literals for multi-line strings
          return `\`${str.replace(/`/g, '\\`')}\``;
        } else {
          // Use single quotes for single-line strings, escaping any single quotes
          return `'${str.replace(/'/g, "\\'")}'`;
        }
      }

      switch (template.type) {
        case 'System':
          return `const ${varName} = new SystemTemplate(${formatString(String(template.data.content))});\n`;

        case 'User':
          return (
            `const ${varName} = new UserTemplate({\n` +
            `  description: ${formatString(String(template.data.description || ''))},\n` +
            (template.data.default
              ? `  default: ${formatString(String(template.data.default))},\n`
              : '') +
            (template.data.inputType === 'runtime'
              ? `  inputSource: customInputSource,\n`
              : '') +
            (template.data.validate
              ? `  validate: ${String(template.data.validate)},\n`
              : '') +
            (template.data.onInput
              ? `  onInput: ${String(template.data.onInput)},\n`
              : '') +
            `});\n`
          );

        case 'Assistant':
          if (
            template.data.assistantType === 'content' &&
            template.data.content
          ) {
            // If using content, we can use the simpler string constructor
            return `const ${varName} = new AssistantTemplate(${formatString(String(template.data.content))});\n`;
          } else {
            // Otherwise use the full object syntax
            return (
              `const ${varName} = new AssistantTemplate({\n` +
              (template.data.model
                ? `  model: ${formatString(String(template.data.model))},\n`
                : '') +
              (template.data.content
                ? `  content: ${formatString(String(template.data.content))},\n`
                : '') +
              `});\n`
            );
          }

        case 'Loop':
          // Use varName directly (already incorporates name)
          let loopCode = `const ${varName} = new LoopTemplate({\n`;

          // Add templates array
          if (children.length > 0) {
            loopCode += `  templates: [\n`;
            children.forEach((child, idx) => {
              const childType = child.type;

              switch (childType) {
                case 'System': {
                  loopCode += `    new SystemTemplate(${formatString(String(child.data.content || ''))})`;
                  break;
                }

                case 'User': {
                  // Check if this is a runtime input user template
                  if (child.data.inputType === 'runtime') {
                    loopCode +=
                      `    new UserTemplate({\n` +
                      `      description: ${formatString(String(child.data.description || ''))},\n` +
                      (child.data.default
                        ? `      default: ${formatString(String(child.data.default))},\n`
                        : '') +
                      `      inputSource: customInputSource,\n` +
                      `    })`;
                  } else {
                    loopCode +=
                      `    new UserTemplate({\n` +
                      `      description: ${formatString(String(child.data.description || ''))},\n` +
                      (child.data.default
                        ? `      default: ${formatString(String(child.data.default))},\n`
                        : '') +
                      `    })`;
                  }
                  break;
                }

                case 'Assistant': {
                  if (
                    child.data.assistantType === 'content' &&
                    child.data.content
                  ) {
                    // Use the simple string constructor for content-only
                    loopCode += `    new AssistantTemplate(${formatString(String(child.data.content))})`;
                  } else {
                    // Use the full object syntax
                    loopCode += `    new AssistantTemplate({`;
                    if (child.data.model)
                      loopCode += `\n      model: ${formatString(String(child.data.model))},`;
                    if (child.data.content)
                      loopCode += `\n      content: ${formatString(String(child.data.content))},`;
                    loopCode += `\n    })`;
                  }
                  break;
                }

                case 'Loop':
                case 'Linear':
                case 'Subroutine': {
                  // For complex template types, reference the variable name
                  const childVarName = varNames.get(child.id);
                  if (childVarName) {
                    loopCode += `    ${childVarName}`;
                  }
                  break;
                }
              }

              if (idx < children.length - 1) {
                loopCode += ',\n';
              } else {
                loopCode += '\n';
              }
            });

            loopCode += `  ],\n`;
          } else {
            loopCode += `  templates: [],\n`;
          }

          // Add exit condition
          loopCode += `  exitCondition: ${String(template.data.exitCondition || '(session) => false')},\n`;
          loopCode += `});\n`;

          return loopCode;

        case 'Subroutine':
          let subroutineCode = `const ${varName} = new SubroutineTemplate({\n`;

          // Add template property (either reference a template or use inline children)
          if (children.length > 0) {
            // If we have children, create an inline template
            subroutineCode += `  template: new LinearTemplate()`;

            // Add children using chained API
            children.forEach((child) => {
              switch (child.type) {
                case 'System': {
                  subroutineCode += `\n    .addSystem(${formatString(String(child.data.content || ''))})`;
                  break;
                }

                case 'User': {
                  // Check if this is a runtime input user template
                  if (child.data.inputType === 'runtime') {
                    subroutineCode +=
                      `\n    .addUser({\n` +
                      `      description: ${formatString(String(child.data.description || ''))},\n` +
                      (child.data.default
                        ? `      default: ${formatString(String(child.data.default))},\n`
                        : '') +
                      `      inputSource: customInputSource,\n` +
                      `    })`;
                  } else {
                    subroutineCode +=
                      `\n    .addUser({\n` +
                      `      description: ${formatString(String(child.data.description || ''))},\n` +
                      (child.data.default
                        ? `      default: ${formatString(String(child.data.default))},\n`
                        : '') +
                      `    })`;
                  }
                  break;
                }

                case 'Assistant': {
                  if (
                    child.data.assistantType === 'content' &&
                    child.data.content
                  ) {
                    subroutineCode += `\n    .addAssistant(${formatString(String(child.data.content))})`;
                  } else {
                    subroutineCode += `\n    .addAssistant({`;
                    if (child.data.model)
                      subroutineCode += `\n      model: ${formatString(String(child.data.model))},`;
                    if (child.data.content)
                      subroutineCode += `\n      content: ${formatString(String(child.data.content))},`;
                    subroutineCode += `\n    })`;
                  }
                  break;
                }

                case 'Loop': {
                  const loopVarName = varNames.get(child.id) || 'loopTemplate';
                  subroutineCode += `\n    .addLoop(${loopVarName})`;
                  break;
                }

                case 'Subroutine': {
                  const subVarName =
                    varNames.get(child.id) || 'subroutineTemplate';
                  subroutineCode += `\n    .addSubroutine(${subVarName})`;
                  break;
                }
              }
            });

            subroutineCode += `,\n`;
          } else if (template.data.templateId) {
            // Use legacy templateId if no children but templateId exists
            subroutineCode += `  templateId: ${formatString(String(template.data.templateId))},\n`;
          } else {
            // Default to empty template
            subroutineCode += `  template: new LinearTemplate(),\n`;
          }

          // Add other required properties
          subroutineCode += `  initWith: ${String(template.data.initWith || '(session) => ({})')},\n`;
          if (template.data.squashWith) {
            subroutineCode += `  squashWith: ${String(template.data.squashWith)},\n`;
          }

          subroutineCode += `});\n`;
          return subroutineCode;

        case 'Linear':
          if (children.length > 0) {
            // Use varName directly (already incorporates name)
            let linearCode = `const ${varName} = new LinearTemplate()`;

            // Add children using chained API
            children.forEach((child) => {
              switch (child.type) {
                case 'System': {
                  linearCode += `\n  .addSystem(${formatString(String(child.data.content || ''))})`;
                  break;
                }

                case 'User': {
                  // Check if this is a runtime input user template
                  if (child.data.inputType === 'runtime') {
                    linearCode +=
                      `\n  .addUser({\n` +
                      `    description: ${formatString(String(child.data.description || ''))},\n` +
                      (child.data.default
                        ? `    default: ${formatString(String(child.data.default))},\n`
                        : '') +
                      `    inputSource: customInputSource,\n` +
                      `  })`;
                  } else {
                    // Fixed input (not using runtime input)
                    linearCode +=
                      `\n  .addUser({\n` +
                      `    description: ${formatString(String(child.data.description || ''))},\n` +
                      (child.data.default
                        ? `    default: ${formatString(String(child.data.default))},\n`
                        : '') +
                      `  })`;
                  }
                  break;
                }

                case 'Assistant': {
                  if (
                    child.data.assistantType === 'content' &&
                    child.data.content
                  ) {
                    // Use the simple string constructor for content-only assistants
                    linearCode += `\n  .addAssistant(${formatString(String(child.data.content))})`;
                  } else {
                    // Use the full object syntax
                    linearCode += `\n  .addAssistant({`;
                    if (child.data.model)
                      linearCode += `\n    model: ${formatString(String(child.data.model))},`;
                    if (child.data.content)
                      linearCode += `\n    content: ${formatString(String(child.data.content))},`;
                    linearCode += `\n  })`;
                  }
                  break;
                }

                case 'Loop': {
                  const loopVarName = varNames.get(child.id) || 'loopTemplate';
                  linearCode += `\n  .addLoop(${loopVarName})`;
                  break;
                }

                case 'Subroutine': {
                  const subVarName =
                    varNames.get(child.id) || 'subroutineTemplate';
                  linearCode += `\n  .addSubroutine(${subVarName})`;
                  break;
                }
              }
            });

            linearCode += `;\n`;
            return linearCode;
          } else {
            // Use varName directly (already incorporates name)
            return `const ${varName} = new LinearTemplate();\n`;
          }

        default:
          return `const ${varName} = {}; // Unknown template type: ${template.type}\n`;
      }
    };

    // Find templates that need to be defined first (not directly nested)
    const standalone = templates.filter(
      (t) => (t.type === 'Loop' || t.type === 'Subroutine') && t.parentId, // not root
    );

    // Generate code for standalone templates first
    standalone.forEach((template) => {
      code += generateTemplateCode(template) + '\n';
    });

    // Find the root template (should be Linear)
    const root = templates.find((t) => !t.parentId);
    if (root) {
      code += generateTemplateCode(root) + '\n';
    }

    // Add export statement
    if (root) {
      const rootVarName = varNames.get(root.id) || 'chatTemplate';
      code += `export default ${rootVarName};\n`;
    } else {
      code += `const chatTemplate = new LinearTemplate();\n\nexport default chatTemplate;\n`;
    }

    return code;
  },

  // Load templates from code
  loadFromCode: (code: string) => {
    try {
      console.log('Parsing code to template structure...', code);
      // Implementation details omitted for brevity
    } catch (error) {
      console.error('Error parsing code:', error);
      // Fall back to default template
      set({ templates: createInitialTemplate() });
    }
  },

  // Reset the store to initial state
  resetStore: () => {
    set({
      templates: createInitialTemplate(),
      selectedId: null,
    });
  },
}));
