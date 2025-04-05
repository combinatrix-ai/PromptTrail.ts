import { Node, Edge } from 'reactflow';
import { nanoid } from 'nanoid';

interface NodeData {
  childIds?: string[];
  parentId?: string;
  description?: string;
  default?: string;
  model?: string;
  content?: string;
  templateId?: string;
  initWith?: string;
  squashWith?: string;
  exitCondition?: string;
  name?: string;
  [key: string]: unknown; // Allow other properties but with unknown type
}

// Simple regex-based parser - a more robust solution would use a proper TS parser like ts-morph
/**
 * Parse template code to a structured graph representation
 */
export function parseTemplateCode(code: string): {
  nodes: Node[];
  edges: Edge[];
} {
  console.log('Parsing code:', code);

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Track templates by variable name
  const templateMap = new Map<
    string,
    {
      id: string;
      type: string;
      parentId?: string;
      node: Node;
    }
  >();

  // Parse variable declarations
  const varDeclarationRegex = /const\s+(\w+)\s*=\s*new\s+(\w+)Template\s*\(/g;
  let match: RegExpExecArray | null;
  let y = 50;

  while ((match = varDeclarationRegex.exec(code)) !== null) {
    const varName = match[1];
    const templateType = match[2];
    const id = `node-${varName}`;

    // Create basic node for each template
    const node: Node = {
      id,
      type: templateType,
      position: { x: 250, y },
      data: extractTemplateData(code, match.index, templateType, varName),
    };

    // Add node to the map
    templateMap.set(varName, { id, type: templateType, node });

    nodes.push(node);
    y += 150;
  }

  // Parse method chains (addSystem, addUser, etc.)
  const methodChainRegex = /(\w+)\s*\.\s*add(\w+)\s*\(/g;
  let methodMatch: RegExpExecArray | null;
  while ((methodMatch = methodChainRegex.exec(code)) !== null) {
    const parentVar = methodMatch[1];
    const childType = methodMatch[2];

    const parentInfo = templateMap.get(parentVar);
    if (
      parentInfo &&
      (parentInfo.type === 'Linear' || parentInfo.type === 'Loop')
    ) {
      // Create a child node
      const childId = `${childType.toLowerCase()}-${nanoid(6)}`;
      const childData = extractMethodArguments(code, methodMatch.index);

      // Add child node
      const childNode: Node = {
        id: childId,
        type: childType,
        position: {
          x: 400,
          y: 100 + nodes.length * 100,
        },
        data: {
          ...childData,
          parentId: parentInfo.id, // Set the parent ID reference
        },
      };

      nodes.push(childNode);

      // Update parent's childIds
      const parentNode = nodes.find((n) => n.id === parentInfo.id);
      if (parentNode) {
        (parentNode.data as NodeData).childIds = [
          ...((parentNode.data as NodeData).childIds || []),
          childId,
        ];
      }

      // Add edge from parent to child
      const edgeId = `edge-${parentInfo.id}-${childId}`;
      edges.push({
        id: edgeId,
        source: parentInfo.id,
        target: childId,
        type: 'smoothstep',
      });
    }
  }

  // Parse addLoop with a new LoopTemplate inside
  const nestedLoopRegex =
    /(\w+)\s*\.\s*addLoop\s*\(\s*new\s+LoopTemplate\s*\(\s*\{([^}]+)\}\s*\)\s*\)/g;
  let loopMatch: RegExpExecArray | null;
  while ((loopMatch = nestedLoopRegex.exec(code)) !== null) {
    const parentVar = loopMatch[1];
    const loopContent = loopMatch[2];

    const parentInfo = templateMap.get(parentVar);
    if (parentInfo && parentInfo.type === 'Linear') {
      // Create a loop node
      const loopId = `loop-${nanoid(6)}`;

      // Extract exit condition if present
      let exitCondition = '(session) => false';
      const exitConditionMatch = loopContent.match(
        /exitCondition\s*:\s*(?:function|\([^)]*\)\s*=>)\s*\{([^}]*)\}/,
      );
      if (exitConditionMatch) {
        exitCondition = `(session) => {${exitConditionMatch[1]}}`;
      }

      // Create loop node
      const loopNode: Node = {
        id: loopId,
        type: 'Loop',
        position: {
          x: 400,
          y: 100 + nodes.length * 100,
        },
        data: {
          childIds: [],
          exitCondition,
          parentId: parentInfo.id,
        },
      };

      nodes.push(loopNode);

      // Update parent's childIds
      const parentNode = nodes.find((n) => n.id === parentInfo.id);
      if (parentNode) {
        (parentNode.data as NodeData).childIds = [
          ...((parentNode.data as NodeData).childIds || []),
          loopId,
        ];
      }

      // Add edge from parent to loop
      const edgeId = `edge-${parentInfo.id}-${loopId}`;
      edges.push({
        id: edgeId,
        source: parentInfo.id,
        target: loopId,
        type: 'smoothstep',
      });

      // Look for templates inside the loop
      const templatesMatch = loopContent.match(
        /templates\s*:\s*\[\s*([^[\]]+)\s*\]/,
      );
      if (templatesMatch) {
        const templatesContent = templatesMatch[1];

        // Find instantiations like "new UserTemplate({ ... })"
        const templateInstRegex =
          /new\s+(\w+)Template\s*\(\s*\{([^}]+)\}\s*\)/g;
        let templateInstMatch: RegExpExecArray | null;
        let childIndex = 0;

        while (
          (templateInstMatch = templateInstRegex.exec(templatesContent)) !==
          null
        ) {
          const childType = templateInstMatch[1];
          const childContent = templateInstMatch[2];

          // Create template node inside loop
          const childId = `${childType.toLowerCase()}-${nanoid(6)}`;

          let childData: Record<string, unknown> = {};
          if (childType === 'User') {
            const descMatch = childContent.match(
              /description\s*:\s*['"`]([^'"`]*)['"`]/,
            );
            const defaultMatch = childContent.match(
              /default\s*:\s*['"`]([^'"`]*)['"`]/,
            );

            childData = {
              description: descMatch ? descMatch[1] : 'User input',
              default: defaultMatch ? defaultMatch[1] : '',
            };
          } else if (childType === 'Assistant') {
            const modelMatch = childContent.match(
              /model\s*:\s*['"`]([^'"`]*)['"`]/,
            );
            const contentMatch = childContent.match(
              /content\s*:\s*['"`]([^'"`]*)['"`]/,
            );

            if (modelMatch) childData.model = modelMatch[1];
            if (contentMatch) childData.content = contentMatch[1];
          }

          const childNode: Node = {
            id: childId,
            type: childType,
            position: {
              x: 500,
              y: 100 + nodes.length * 100 + childIndex * 80,
            },
            data: {
              ...childData,
              parentId: loopId,
            },
          };

          nodes.push(childNode);

          // Update loop's childIds
          const loopNode = nodes.find((n) => n.id === loopId);
          if (loopNode) {
            (loopNode.data as NodeData).childIds = [
              ...((loopNode.data as NodeData).childIds || []),
              childId,
            ];
          }

          // Add edge from loop to child
          const childEdgeId = `edge-${loopId}-${childId}`;
          edges.push({
            id: childEdgeId,
            source: loopId,
            target: childId,
            type: 'smoothstep',
          });

          childIndex++;
        }
      }
    }
  }

  // Parse template composition (templates passed as constructor arguments)
  const templateCompositionRegex =
    /new\s+(\w+)Template\s*\(\s*\{\s*templates\s*:\s*\[\s*([^[\]]+)\s*\]/g;
  let templateMatch: RegExpExecArray | null;
  while ((templateMatch = templateCompositionRegex.exec(code)) !== null) {
    const containerType = templateMatch[1];
    const childrenStr = templateMatch[2];

    // Extract children variable names
    const childVars = childrenStr.split(',').map((v) => v.trim());

    // Find container node
    const containerNode = nodes.find((node) => {
      if (!node.type) return false;
      return (
        node.type === containerType &&
        node.position.y <= (templateMatch?.index || 0) &&
        !((node.data as NodeData).childIds?.length)
      );
    });

    if (containerNode) {
      (containerNode.data as NodeData).childIds = [];

      // Link children to container
      childVars.forEach((childVar) => {
        const childInfo = templateMap.get(childVar);
        if (childInfo) {
          (containerNode.data as NodeData).childIds.push(childInfo.id);

          // Find the child node and update its parentId
          const childNode = nodes.find((node) => node.id === childInfo.id);
          if (childNode) {
            childNode.data = {
              ...(childNode.data as NodeData),
              parentId: containerNode.id,
            };
          }

          // Add edge
          const edgeId = `edge-${containerNode.id}-${childInfo.id}`;
          edges.push({
            id: edgeId,
            source: containerNode.id,
            target: childInfo.id,
            type: 'smoothstep',
          });
        }
      });
    }
  }

  // If we found any LinearTemplate or LoopTemplate that don't have children,
  // it's likely they're created using the constructor pattern
  nodes.forEach((node) => {
    if (
      (node.type === 'Linear' || node.type === 'Loop') &&
      !(node.data as NodeData).childIds
    ) {
      (node.data as NodeData).childIds = [];
    }
  });

  return { nodes, edges };
}

/**
 * Extract template data based on template type and code context
 */
function extractTemplateData(
  code: string,
  index: number,
  type: string,
  varName: string,
): Record<string, unknown> {
  // Default data based on type
  const data: Record<string, unknown> = {};

  switch (type) {
    case 'System': {
      // Look for content in constructor or in addSystem call
      const systemContentRegex = new RegExp(
        `new SystemTemplate\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)`,
        'g',
      );
      systemContentRegex.lastIndex = index;
      const systemMatch = systemContentRegex.exec(code);
      if (systemMatch) {
        data.content = systemMatch[1];
      } else {
        data.content = 'System content';
      }
      break;
    }

    case 'User': {
      // Extract description and default value
      const userRegex = new RegExp(
        `new UserTemplate\\s*\\(\\s*\\{\\s*description\\s*:\\s*['"\`]([^'"\`]+)['"\`](?:,\\s*default\\s*:\\s*['"\`]([^'"\`]*)['"\`])?`,
        'g',
      );
      userRegex.lastIndex = index;
      const userMatch = userRegex.exec(code);
      if (userMatch) {
        data.description = userMatch[1];
        data.default = userMatch[2] || '';
      } else {
        data.description = 'User input';
        data.default = '';
      }
      break;
    }

    case 'Assistant': {
      // Extract model and content
      const assistantRegex = new RegExp(
        `new AssistantTemplate\\s*\\(\\s*\\{\\s*(?:model\\s*:\\s*['"\`]([^'"\`]+)['"\`])?(?:,\\s*content\\s*:\\s*['"\`]([^'"\`]+)['"\`])?`,
        'g',
      );
      assistantRegex.lastIndex = index;
      const assistantMatch = assistantRegex.exec(code);
      if (assistantMatch) {
        if (assistantMatch[1]) data.model = assistantMatch[1];
        if (assistantMatch[2]) data.content = assistantMatch[2];
      } else {
        data.model = 'gpt-4o-mini';
      }
      break;
    }

    case 'Linear': {
      // Linear template has childIds
      data.childIds = [];
      data.id = `node-${varName}`; // Save id for references
      break;
    }

    case 'Loop': {
      // Loop template has childIds and exitCondition
      data.childIds = [];
      data.id = `node-${varName}`; // Save id for references

      // Try to extract exitCondition
      const exitConditionRegex =
        /exitCondition\s*:\s*(?:function|\([^)]*\)\s*=>)\s*\{([^}]*)\}/g;
      exitConditionRegex.lastIndex = index;
      const exitMatch = exitConditionRegex.exec(code);
      if (exitMatch) {
        data.exitCondition = `(session) => {${exitMatch[1]}}`;
      } else {
        data.exitCondition = '(session) => false';
      }
      break;
    }

    case 'Subroutine': {
      // Extract templateId and initWith
      const subroutineRegex = new RegExp(
        `new SubroutineTemplate\\s*\\(\\s*\\{\\s*templateId\\s*:\\s*['"\`]([^'"\`]+)['"\`]`,
        'g',
      );
      subroutineRegex.lastIndex = index;
      const subroutineMatch = subroutineRegex.exec(code);
      if (subroutineMatch) {
        data.templateId = subroutineMatch[1];
      } else {
        data.templateId = '';
      }
      data.initWith = '(session) => ({})';
      break;
    }
  }

  return data;
}

/**
 * Extract method arguments for add* methods
 */
function extractMethodArguments(
  code: string,
  index: number,
): Record<string, unknown> {
  // Try to find the method name
  const methodNameRegex = /\.add(\w+)\s*\(/g;
  methodNameRegex.lastIndex = index;
  const methodMatch = methodNameRegex.exec(code);

  if (!methodMatch) return {};

  const methodType = methodMatch[1];
  const startIndex = methodMatch.index + methodMatch[0].length;

  // Find the closing parenthesis, accounting for nested parentheses
  let depth = 1;
  let endIndex = startIndex;

  while (depth > 0 && endIndex < code.length) {
    if (code[endIndex] === '(') depth++;
    else if (code[endIndex] === ')') depth--;
    endIndex++;
  }

  const argsStr = code.substring(startIndex, endIndex - 1).trim();

  // Different handling based on method type
  switch (methodType) {
    case 'System': {
      // Usually a string argument
      if (
        argsStr.startsWith("'") ||
        argsStr.startsWith('"') ||
        argsStr.startsWith('`')
      ) {
        return { content: argsStr.slice(1, -1) };
      }
      return { content: 'System content' };
    }

    case 'User': {
      // Could be a string or object
      if (argsStr.startsWith('{')) {
        // Object format
        const descMatch = argsStr.match(/description\s*:\s*(['"`])([^'"`]*)\1/);
        const defaultMatch = argsStr.match(/default\s*:\s*(['"`])([^'"`]*)\1/);

        return {
          description: descMatch ? descMatch[2] : 'User input',
          default: defaultMatch ? defaultMatch[2] : '',
        };
      } else if (argsStr.includes(',')) {
        // Two string arguments: description, default
        const args = argsStr.split(',').map((arg) => {
          const trimmed = arg.trim();
          if (
            trimmed.startsWith("'") ||
            trimmed.startsWith('"') ||
            trimmed.startsWith('`')
          ) {
            return trimmed.slice(1, -1);
          }
          return trimmed;
        });

        return {
          description: args[0] || 'User input',
          default: args[1] || '',
        };
      } else {
        // Single string argument: description
        if (
          argsStr.startsWith("'") ||
          argsStr.startsWith('"') ||
          argsStr.startsWith('`')
        ) {
          return { description: argsStr.slice(1, -1), default: '' };
        }
        return { description: 'User input', default: '' };
      }
    }

    case 'Assistant': {
      // Could be object with model and content
      if (argsStr.startsWith('{')) {
        const modelMatch = argsStr.match(/model\s*:\s*(['"`])([^'"`]*)\1/);
        const contentMatch = argsStr.match(/content\s*:\s*(['"`])([^'"`]*)\1/);

        const data: Record<string, unknown> = {};
        if (modelMatch) data.model = modelMatch[2];
        if (contentMatch) data.content = contentMatch[2];

        return data;
      }
      return { model: 'gpt-4o-mini' };
    }

    default:
      return {};
  }
}

/**
 * Generate template code from a structured graph representation
 */
export function generateTemplateCode(graph: {
  nodes: Node[];
  edges: Edge[];
}): string {
  console.log('Generating code from graph:', graph);

  const { nodes, edges } = graph;

  // Skip if no nodes
  if (nodes.length === 0) {
    return `import { LinearTemplate } from '@prompttrail/core';\n\nconst template = new LinearTemplate();\n\nexport default template;\n`;
  }

  // Start with imports
  let code = `import {
  LinearTemplate,
  SystemTemplate,
  UserTemplate,
  AssistantTemplate,
  LoopTemplate,
  SubroutineTemplate,
} from '@prompttrail/core';\n\n`;

  // First, find the root nodes (nodes without parents)
  const allChildIds = new Set<string>();

  // Track parent-child relationships
  nodes.forEach((node) => {
    if ((node.data as NodeData).parentId) {
      allChildIds.add(node.id);
    }
  });

  // Root nodes are those not in childIds
  const rootNodes = nodes.filter((node) => !allChildIds.has(node.id));

  if (rootNodes.length === 0 && nodes.length > 0) {
    // If no root nodes were found but we have nodes, use the first node as root
    rootNodes.push(nodes[0]);
  }

  // Track the variable names for each node
  const nodeVarNames = new Map<string, string>();

  // Assign variable names based on type and position in the list
  // Use a more deterministic naming convention
  const typeCounts: Record<string, number> = {};

  // First assign names to all nodes
  nodes.forEach((node) => {
    if (!node.type) return;

    const type = node.type.toLowerCase();
    typeCounts[type] = (typeCounts[type] || 0) + 1;

    let baseName: string;
    if (type === 'linear' && rootNodes.includes(node)) {
      baseName = 'chatTemplate'; // Use chatTemplate for root linear template
    } else {
      baseName = `${type}Template${typeCounts[type]}`;
    }

    nodeVarNames.set(node.id, baseName);
  });

  // Helper function to find child nodes
  const getChildNodes = (nodeId: string): Node[] => {
    // First check if the node has childIds
    const node = nodes.find((n) => n.id === nodeId);
    if (node && node.data && (node.data as NodeData).childIds) {
      const childIds = (node.data as NodeData).childIds as string[];
      // Sort children by their y-position to maintain a logical order
      return nodes
        .filter((n) => childIds.includes(n.id))
        .sort((a, b) => a.position.y - b.position.y);
    }

    // Otherwise find children via edges
    const outgoingEdges = edges.filter((edge) => edge.source === nodeId);
    const childIds = outgoingEdges.map((edge) => edge.target);

    // Return sorted child nodes
    return nodes
      .filter((node) => childIds.includes(node.id))
      .sort((a, b) => a.position.y - b.position.y);
  };

  // Generate code for Loop templates first
  const loopNodes = nodes.filter((node) => node.type === 'Loop');

  loopNodes.forEach((node) => {
    const varName = nodeVarNames.get(node.id) || 'loopTemplate';
    const children = getChildNodes(node.id);
    // We don't need childVars here, so we'll comment it out
    // const childVars = children
    //   .map((child) => nodeVarNames.get(child.id))
    //   .filter(Boolean);

    // Generate Loop template
    if (children.length > 0) {
      code += `const ${varName} = new LoopTemplate({\n`;
      code += `  templates: [\n`;

      // Generate nested template declarations for each child
      children.forEach((child, idx) => {
        const isLast = idx === children.length - 1;

        switch (child.type) {
          case 'User': {
            code += `    new UserTemplate({\n`;
            code += `      description: '${(child.data as NodeData).description || ''}',\n`;
            if ((child.data as NodeData).default)
              code += `      default: '${(child.data as NodeData).default}',\n`;
            code += `    })${isLast ? '' : ','}\n`;
            break;
          }

          case 'Assistant': {
            code += `    new AssistantTemplate({\n`;
            if ((child.data as NodeData).model)
              code += `      model: '${(child.data as NodeData).model}',\n`;
            if ((child.data as NodeData).content)
              code += `      content: '${(child.data as NodeData).content}',\n`;
            code += `    })${isLast ? '' : ','}\n`;
            break;
          }

          case 'System': {
            code += `    new SystemTemplate('${(child.data as NodeData).content || ''}')${isLast ? '' : ','}\n`;
            break;
          }
        }
      });

      code += `  ],\n`;
    } else {
      code += `const ${varName} = new LoopTemplate({\n`;
      code += `  templates: [],\n`;
    }

    // Add exit condition
    code += `  exitCondition: ${(node.data as NodeData).exitCondition || '(session) => false'},\n`;
    code += `});\n\n`;
  });

  // Generate code for independent templates
  const independentTemplates = nodes.filter(
    (node) =>
      node.type !== 'Linear' && node.type !== 'Loop' && !(node.data as NodeData).parentId,
  );

  independentTemplates.forEach((node) => {
    const varName = nodeVarNames.get(node.id) || 'template';

    switch (node.type) {
      case 'System': {
        code += `const ${varName} = new SystemTemplate('${(node.data as NodeData).content || ''}');\n\n`;
        break;
      }

      case 'User': {
        code += `const ${varName} = new UserTemplate({\n`;
        code += `  description: '${(node.data as NodeData).description || ''}',\n`;
        if ((node.data as NodeData).default) code += `  default: '${(node.data as NodeData).default}',\n`;
        code += `});\n\n`;
        break;
      }

      case 'Assistant': {
        code += `const ${varName} = new AssistantTemplate({\n`;
        if ((node.data as NodeData).model) code += `  model: '${(node.data as NodeData).model}',\n`;
        if ((node.data as NodeData).content) code += `  content: '${(node.data as NodeData).content}',\n`;
        code += `});\n\n`;
        break;
      }

      case 'Subroutine': {
        code += `const ${varName} = new SubroutineTemplate({\n`;
        code += `  templateId: '${(node.data as NodeData).templateId || ''}',\n`;
        code += `  initWith: ${(node.data as NodeData).initWith || '(session) => ({})'},\n`;
        if ((node.data as NodeData).squashWith)
          code += `  squashWith: ${(node.data as NodeData).squashWith},\n`;
        code += `});\n\n`;
        break;
      }
    }
  });

  // Generate code for Linear templates
  const linearNodes = rootNodes.filter((node) => node.type === 'Linear');

  linearNodes.forEach((node) => {
    const varName = nodeVarNames.get(node.id) || 'chatTemplate';
    const children = getChildNodes(node.id);

    if (children.length > 0) {
      // Always use chained API for linear templates with children
      code += `const ${varName} = new LinearTemplate()`;

      // Add children using the chained API
      children.forEach((child) => {
        if (child.type === 'System') {
          code += `\n  .addSystem('${(child.data as NodeData).content || ''}')`;
        } else if (child.type === 'User') {
          code += `\n  .addUser({\n`;
          code += `    description: '${(child.data as NodeData).description || ''}',\n`;
          if ((child.data as NodeData).default)
            code += `    default: '${(child.data as NodeData).default}',\n`;
          code += `  })`;
        } else if (child.type === 'Assistant') {
          code += `\n  .addAssistant({`;
          if ((child.data as NodeData).model) code += `\n    model: '${(child.data as NodeData).model}',`;
          if ((child.data as NodeData).content)
            code += `\n    content: '${(child.data as NodeData).content}',`;
          code += `\n  })`;
        } else if (child.type === 'Loop') {
          const loopVarName = nodeVarNames.get(child.id) || 'loopTemplate';
          code += `\n  .addLoop(\n    ${loopVarName}\n  )`;
        }
      });

      code += `;\n\n`;
    } else {
      // Empty linear template
      code += `const ${varName} = new LinearTemplate();\n\n`;
    }
  });

  // Add export statement for the main template
  // Prefer Linear templates as root, otherwise use any root node
  const mainNode =
    linearNodes.length > 0
      ? linearNodes[0]
      : rootNodes.length > 0
        ? rootNodes[0]
        : nodes[0];
  const mainVarName = nodeVarNames.get(mainNode.id) || 'chatTemplate';

  code += `export default ${mainVarName};\n`;

  return code;
}
