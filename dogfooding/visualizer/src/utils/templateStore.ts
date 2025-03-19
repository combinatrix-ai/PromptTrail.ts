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
    [key: string]: string | number | boolean | string[] | undefined;
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
    childIds?: string[];
    templateId?: string;
    initWith: string; // Function as string
    squashWith?: string; // Function as string
  };
}

// Store interface
interface TemplateStore {
  templates: TemplateNode[];
  selectedId: string | null;
  addTemplate: (
    parentId: string | null,
    type: TemplateType,
    position?: number,
  ) => string;
  updateTemplate: (id: string, data: Partial<TemplateNode>) => void;
  removeTemplate: (id: string) => void;
  selectTemplate: (id: string | null) => void;
  moveTemplate: (id: string, newPosition: number) => void;
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

export const useTemplateStore = create<TemplateStore>((set, get) => ({
  templates: createInitialTemplate(),
  selectedId: null,
  addTemplate: (
    parentId: string | null,
    type: TemplateType,
    position?: number,
  ): string => {
    const templates = get().templates;
    let parent: TemplateNode | undefined;
    if (parentId) {
      parent = templates.find((t: TemplateNode) => t.id === parentId);
      if (!parent) {
        throw new Error(`Parent template with ID ${parentId} not found`);
      }
      if (
        parent.type !== 'Linear' &&
        parent.type !== 'Loop' &&
        parent.type !== 'Subroutine'
      ) {
        throw new Error(`Template type ${parent.type} cannot have children`);
      }
      if (type === 'System') {
        const children = get().getChildTemplates(parentId);
        if (children.length > 0) {
          if (position !== 0 && position !== undefined) {
            const parentTemplate = templates.find(
              (t: TemplateNode) => t.id === parentId,
            );
            if (parentTemplate?.type !== 'Subroutine') {
              throw new Error(
                'System template must be placed at the top of its container',
              );
            }
          }
        }
        if (position === 0 || position === undefined) {
          let isValidPosition = true;
          const checkParentHierarchy = (templateId: string): boolean => {
            const template = templates.find(
              (t: TemplateNode) => t.id === templateId,
            );
            if (!template || !template.parentId) return true;
            const parentId = template.parentId;
            const siblings = get().getChildTemplates(parentId);
            if (template.position !== 0 && siblings.length > 0) {
              const parentTemplate = templates.find(
                (t: TemplateNode) => t.id === parentId,
              );
              if (parentTemplate && parentTemplate.type !== 'Subroutine') {
                return false;
              }
            }
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
    const id = nanoid(6);
    const pos =
      position !== undefined
        ? position
        : parent
          ? get().getChildTemplates(parentId!).length
          : 0;
    const newTemplate: TemplateNode = {
      id,
      type,
      parentId: parentId ?? undefined,
      position: pos,
      data: {},
    };
    let defaultName = '';
    if (['Linear', 'Loop', 'Subroutine'].includes(type)) {
      const typeCount =
        templates.filter((t: TemplateNode) => t.type === type).length + 1;
      if (type === 'Linear' && !parentId) {
        defaultName = 'chatTemplate';
      } else {
        const typeLower = type.toLowerCase();
        defaultName = `${typeLower}Template${typeCount}`;
      }
    }
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
          inputType: 'runtime',
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
    set({
      templates: [...templates, newTemplate],
      selectedId: id,
    });
    return id;
  },
  updateTemplate: (id: string, data: Partial<TemplateNode>) => {
    set((state) => ({
      templates: state.templates.map((template) =>
        template.id === id
          ? {
              ...template,
              ...data,
              data: { ...template.data, ...(data.data || {}) },
            }
          : template,
      ),
    }));
  },
  removeTemplate: (id: string) => {
    const templates = get().templates;
    const rootTemplate = get().getRootTemplate();
    if (rootTemplate && rootTemplate.id === id) {
      console.warn('Cannot remove the root LinearTemplate');
      return;
    }
    const template = templates.find((t: TemplateNode) => t.id === id);
    if (!template) return;
    const getDescendantIds = (templateId: string): string[] => {
      const children = templates.filter(
        (t: TemplateNode) => t.parentId === templateId,
      );
      const childIds: string[] = children.map((c: TemplateNode) => c.id);
      const descendantIds: string[] = childIds.flatMap(
        (cId: string): string[] => getDescendantIds(cId),
      );
      return [...childIds, ...descendantIds];
    };
    const idsToRemove = [id, ...getDescendantIds(id)];
    const siblings = templates
      .filter(
        (t: TemplateNode) => t.parentId === template.parentId && t.id !== id,
      )
      .sort((a: TemplateNode, b: TemplateNode) => a.position - b.position);
    const updatedSiblings = siblings.map(
      (sibling: TemplateNode, idx: number) => ({
        ...sibling,
        position: idx,
      }),
    );
    const remainingTemplates = templates
      .filter((t: TemplateNode) => !idsToRemove.includes(t.id))
      .map((t: TemplateNode) => {
        const updated = updatedSiblings.find(
          (s: TemplateNode) => s.id === t.id,
        );
        return updated || t;
      });
    set({
      templates: remainingTemplates,
      selectedId: template.parentId || null,
    });
  },
  selectTemplate: (id: string | null) => {
    set({ selectedId: id });
  },
  moveTemplate: (id: string, newPosition: number) => {
    const templates = get().templates;
    const template = templates.find((t: TemplateNode) => t.id === id);
    if (!template) return;
    const parentId = template.parentId;
    const siblings = templates
      .filter((t: TemplateNode) => t.parentId === parentId)
      .sort((a: TemplateNode, b: TemplateNode) => a.position - b.position);
    const maxPosition = siblings.length - 1;
    const validPosition = Math.max(0, Math.min(newPosition, maxPosition));
    if (validPosition === template.position) return;
    const newSiblings = [...siblings];
    newSiblings.splice(template.position, 1);
    newSiblings.splice(validPosition, 0, template);
    const updatedSiblings = newSiblings.map(
      (sibling: TemplateNode, idx: number) => ({
        ...sibling,
        position: idx,
      }),
    );
    set({
      templates: templates.map((t: TemplateNode) => {
        const updated = updatedSiblings.find(
          (s: TemplateNode) => s.id === t.id,
        );
        return updated || t;
      }),
    });
  },
  getRootTemplate: (): TemplateNode | undefined => {
    const templates = get().templates;
    return templates.find((t: TemplateNode) => !t.parentId);
  },
  getChildTemplates: (parentId: string): TemplateNode[] => {
    const templates = get().templates;
    return templates
      .filter((t: TemplateNode) => t.parentId === parentId)
      .sort((a: TemplateNode, b: TemplateNode) => a.position - b.position);
  },
  generateCode: (): string => {
    const templates = get().templates;
    if (templates.length === 0) {
      return `import { LinearTemplate } from '@prompttrail/core';\n\nconst chatTemplate = new LinearTemplate();\n\nexport default chatTemplate;\n`;
    }
    console.log('Generating code for templates:', templates);
    let code = `import {\n`;
    const usedTypes = new Set(templates.map((t: TemplateNode) => t.type));
    usedTypes.forEach((type: string) => {
      code += `  ${type}Template,\n`;
    });
    code += `} from '@prompttrail/core';\n`;
    const hasRuntimeUserTemplates = templates.some(
      (t: TemplateNode) => t.type === 'User' && t.data.inputType === 'runtime',
    );
    if (hasRuntimeUserTemplates) {
      code += `import { customInputSource } from './customInputSource';\n`;
    }
    code += `\n`;
    const varNames = new Map<string, string>();
    const typeCounts: Record<string, number> = {};
    templates.forEach((template: TemplateNode) => {
      const type = template.type.toLowerCase();
      typeCounts[type] = (typeCounts[type] || 0) + 1;
      let varName: string;
      if (type === 'linear' && !template.parentId) {
        varName = 'chatTemplate';
      } else if (
        template.data.name &&
        ['linear', 'loop', 'subroutine'].includes(type)
      ) {
        const validName = String(template.data.name)
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .replace(/^[0-9]/, '_');
        let uniqueName = validName;
        let count = 1;
        while ([...varNames.values()].includes(uniqueName)) {
          uniqueName = `${validName}${count}`;
          count++;
        }
        varName = uniqueName;
      } else {
        varName = `${type}Template${typeCounts[type]}`;
      }
      varNames.set(template.id, varName);
    });
    const generateTemplateCode = (template: TemplateNode): string => {
      const varName = varNames.get(template.id) || 'template';
      const children: TemplateNode[] = get().getChildTemplates(template.id);
      function formatString(str: string): string {
        if (!str) return '';
        if (str.includes('\n')) {
          return `\`${str.replace(/`/g, '\\`')}\``;
        } else {
          return `'${str.replace(/'/g, "\\'")}'`;
        }
      }
      switch (template.type) {
        case 'System':
          return `const ${varName} = new SystemTemplate(${formatString(
            String(template.data.content),
          )});\n`;
        case 'User':
          return (
            `const ${varName} = new UserTemplate({\n` +
            `  description: ${formatString(
              String(template.data.description || ''),
            )},\n` +
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
            return `const ${varName} = new AssistantTemplate(${formatString(
              String(template.data.content),
            )});\n`;
          } else {
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
        case 'Loop': {
          let loopCode = `const ${varName} = new LoopTemplate({\n`;
          if (children.length > 0) {
            loopCode += `  templates: [\n`;
            children.forEach((child: TemplateNode, idx: number) => {
              switch (child.type) {
                case 'System': {
                  loopCode += `    new SystemTemplate(${formatString(
                    String(child.data.content || ''),
                  )})`;
                  break;
                }
                case 'User': {
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
                    loopCode += `    new AssistantTemplate(${formatString(
                      String(child.data.content),
                    )})`;
                  } else {
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
          loopCode += `  exitCondition: ${String(
            template.data.exitCondition || '(session) => false',
          )},\n`;
          loopCode += `});\n`;
          return loopCode;
        }
        case 'Subroutine': {
          let subroutineCode = `const ${varName} = new SubroutineTemplate({\n`;
          if (children.length > 0) {
            subroutineCode += `  template: new LinearTemplate()`;
            children.forEach((child: TemplateNode) => {
              switch (child.type) {
                case 'System': {
                  subroutineCode += `\n    .addSystem(${formatString(String(child.data.content || ''))})`;
                  break;
                }
                case 'User': {
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
            subroutineCode += `  templateId: ${formatString(String(template.data.templateId))},\n`;
          } else {
            subroutineCode += `  template: new LinearTemplate(),\n`;
          }
          subroutineCode += `  initWith: ${String(template.data.initWith || '(session) => ({})')},\n`;
          if (template.data.squashWith) {
            subroutineCode += `  squashWith: ${String(template.data.squashWith)},\n`;
          }
          subroutineCode += `});\n`;
          return subroutineCode;
        }
        case 'Linear': {
          if (children.length > 0) {
            let linearCode = `const ${varName} = new LinearTemplate()`;
            children.forEach((child: TemplateNode) => {
              switch (child.type) {
                case 'System': {
                  linearCode += `\n  .addSystem(${formatString(String(child.data.content || ''))})`;
                  break;
                }
                case 'User': {
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
                    linearCode += `\n  .addAssistant(${formatString(String(child.data.content))})`;
                  } else {
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
            return `const ${varName} = new LinearTemplate();\n`;
          }
        }
        default:
          return `const ${varName} = {}; // Unknown template type: ${template.type}\n`;
      }
    };
    const standalone: TemplateNode[] = templates.filter(
      (t: TemplateNode) =>
        (t.type === 'Loop' || t.type === 'Subroutine') && t.parentId,
    );
    standalone.forEach((template: TemplateNode) => {
      code += generateTemplateCode(template) + '\n';
    });
    const root: TemplateNode | undefined = templates.find(
      (t: TemplateNode) => !t.parentId,
    );
    if (root) {
      code += generateTemplateCode(root) + '\n';
    }
    if (root) {
      const rootVarName = varNames.get(root.id) || 'chatTemplate';
      code += `export default ${rootVarName};\n`;
    } else {
      code += `const chatTemplate = new LinearTemplate();\n\nexport default chatTemplate;\n`;
    }
    return code;
  },
  loadFromCode: (code: string): void => {
    try {
      console.log('Parsing code to template structure...', code);
    } catch (error: unknown) {
      console.error('Error parsing code:', error);
      set({ templates: createInitialTemplate() });
    }
  },
  resetStore: (): void => {
    set({
      templates: createInitialTemplate(),
      selectedId: null,
    });
  },
}));
