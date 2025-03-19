import React, { useState } from 'react';
import {
  useTemplateStore,
  TemplateNode,
  TemplateType,
} from '../utils/templateStore';

// Node type-specific components
import SystemTemplateContent from './templates/SystemTemplateContent';
import UserTemplateContent from './templates/UserTemplateContent';
import AssistantTemplateContent from './templates/AssistantTemplateContent';
import LoopTemplateContent from './templates/LoopTemplateContent';
import SubroutineTemplateContent from './templates/SubroutineTemplateContent';
import LinearTemplateContent from './templates/LinearTemplateContent';

interface TemplateNodeProps {
  node: TemplateNode;
  isSelected: boolean;
  onSelect: () => void;
  level: number; // Nesting level for indentation
}

/**
 * Component to render a single template node
 */
const TemplateNodeComponent: React.FC<TemplateNodeProps> = ({
  node,
  isSelected,
  onSelect,
  level,
}) => {
  const {
    getChildTemplates,
    selectTemplate,
    addTemplate,
    removeTemplate,
    moveTemplate,
    updateTemplate,
    selectedId,
  } = useTemplateStore();

  const [isExpanded, setIsExpanded] = useState(true);

  // Get children if this is a container node
  const isContainer =
    node.type === 'Linear' ||
    node.type === 'Loop' ||
    node.type === 'Subroutine';
  const children = isContainer ? getChildTemplates(node.id) : [];

  // Handlers
  const handleAddChild = (type: TemplateType) => {
    addTemplate(node.id, type);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete this ${node.type} template?`)) {
      removeTemplate(node.id);
    }
  };

  const handleMoveUp = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.position > 0) {
      moveTemplate(node.id, node.position - 1);
    }
  };

  const handleMoveDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    // We don't know the max position here, but the store will handle validation
    moveTemplate(node.id, node.position + 1);
  };

  // Toggle expansion
  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded(!isExpanded);
  };

  // Define different background colors for different template types
  const getBackgroundColor = (): string => {
    switch (node.type) {
      case 'System':
        return 'bg-blue-100';
      case 'User':
        return 'bg-green-100';
      case 'Assistant':
        return 'bg-purple-100';
      case 'Linear':
        return 'bg-gray-100';
      case 'Loop':
        return 'bg-yellow-100';
      case 'Subroutine':
        return 'bg-red-100';
      default:
        return 'bg-white';
    }
  };

  // Define styles for container and regular nodes
  const containerClasses = `
    container-node
    ${isSelected ? 'ring-2 ring-blue-700' : 'hover:ring-1 hover:ring-blue-300'}
    rounded-lg
    p-4
    mb-4
    transition-all
    duration-200
    shadow-md
    hover:shadow-lg
    border-2
    ${
      node.type === 'Linear'
        ? 'border-gray-400 bg-gray-50'
        : node.type === 'Loop'
          ? 'border-yellow-300 bg-yellow-50'
          : 'border-red-300 bg-red-50'
    }
  `;

  const nodeClasses = `
    template-node
    ${getBackgroundColor()}
    ${isSelected ? 'ring-2 ring-blue-500' : 'hover:ring-1 hover:ring-blue-300'}
    rounded-lg
    p-3
    ${!isContainer ? 'mb-2' : ''}
    cursor-pointer
    transition-all
    duration-200
    shadow-sm
    hover:shadow
  `;

  // Render the content based on the node type
  const renderContent = () => {
    switch (node.type) {
      case 'System': {
        const content = node.data.content ? String(node.data.content) : '';
        return <SystemTemplateContent content={content} nodeId={node.id} />;
      }

      case 'User': {
        const description = node.data.description
          ? String(node.data.description)
          : '';
        const defaultValue = node.data.default
          ? String(node.data.default)
          : undefined;
        return (
          <UserTemplateContent
            description={description}
            defaultValue={defaultValue}
            nodeId={node.id}
          />
        );
      }

      case 'Assistant': {
        const assistantType = node.data.assistantType as
          | 'model'
          | 'content'
          | undefined;
        const model = node.data.model ? String(node.data.model) : undefined;
        const content = node.data.content
          ? String(node.data.content)
          : undefined;
        return (
          <AssistantTemplateContent
            assistantType={assistantType}
            model={model}
            content={content}
            nodeId={node.id}
          />
        );
      }

      case 'Loop': {
        const exitCondition = node.data.exitCondition
          ? String(node.data.exitCondition)
          : '';
        const name = node.data.name ? String(node.data.name) : undefined;
        return (
          <LoopTemplateContent
            exitCondition={exitCondition}
            name={name}
            nodeId={node.id}
          />
        );
      }

      case 'Subroutine': {
        const templateId = node.data.templateId
          ? String(node.data.templateId)
          : undefined;
        const initWith = node.data.initWith ? String(node.data.initWith) : '';
        const squashWith = node.data.squashWith
          ? String(node.data.squashWith)
          : undefined;
        const name = node.data.name ? String(node.data.name) : undefined;
        return (
          <SubroutineTemplateContent
            templateId={templateId}
            initWith={initWith}
            squashWith={squashWith}
            name={name}
            nodeId={node.id}
          />
        );
      }

      case 'Linear': {
        const name = node.data.name ? String(node.data.name) : undefined;
        return <LinearTemplateContent name={name} nodeId={node.id} />;
      }

      default:
        return <div className="text-sm">Unknown Template Type</div>;
    }
  };

  // Add template menu
  const renderAddTemplateMenu = () => {
    if (!isContainer) return null;

    // Check if there are existing children to determine if System should be disabled
    const hasChildren = children.length > 0;
    const systemDisabled = hasChildren;

    return (
      <div className="add-template-menu p-2 border-t border-gray-200 mt-3">
        <div className="flex flex-wrap gap-2 justify-center">
          <button
            className={`px-2 py-1 text-xs ${systemDisabled ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-500 hover:bg-blue-600'} text-white rounded-md shadow-sm`}
            onClick={() => !systemDisabled && handleAddChild('System')}
            disabled={systemDisabled}
            title={
              systemDisabled
                ? 'System template must be at the top'
                : 'Add System template'
            }
          >
            +System
          </button>
          <button
            className="px-2 py-1 text-xs bg-green-500 text-white rounded-md shadow-sm hover:bg-green-600"
            onClick={() => handleAddChild('User')}
          >
            +User
          </button>
          <button
            className="px-2 py-1 text-xs bg-purple-500 text-white rounded-md shadow-sm hover:bg-purple-600"
            onClick={() => handleAddChild('Assistant')}
          >
            +Assistant
          </button>
          <button
            className="px-2 py-1 text-xs bg-yellow-500 text-white rounded-md shadow-sm hover:bg-yellow-600"
            onClick={() => handleAddChild('Loop')}
          >
            +Loop
          </button>
          <button
            className="px-2 py-1 text-xs bg-gray-500 text-white rounded-md shadow-sm hover:bg-gray-600"
            onClick={() => handleAddChild('Linear')}
          >
            +Linear
          </button>
          <button
            className="px-2 py-1 text-xs bg-red-500 text-white rounded-md shadow-sm hover:bg-red-600"
            onClick={() => handleAddChild('Subroutine')}
          >
            +Subroutine
          </button>
        </div>
      </div>
    );
  };

  // Layout with indentation based on nesting level
  const marginLeft = `${level * 1.5}rem`;

  return (
    <div className="template-node-wrapper" style={{ marginLeft }}>
      {/* For container nodes, wrap everything in a single component with clear visual boundary */}
      <div className={isContainer ? containerClasses : ''}>
        <div className={nodeClasses} onClick={onSelect}>
          {/* Header with type and expand/collapse for containers */}
          <div className="flex justify-between items-center mb-2">
            <div className="font-bold text-sm flex items-center">
              {/* Add type selector for container templates */}
              {!node.parentId ||
              ['Linear', 'Loop', 'Subroutine'].includes(node.type) ? (
                <select
                  className="mr-2 p-1 text-xs bg-transparent border border-gray-300 rounded"
                  value={node.type}
                  onChange={(e) => {
                    const newType = e.target.value as TemplateType;
                    // Only allow conversion between container types
                    if (['Linear', 'Loop', 'Subroutine'].includes(newType)) {
                      // Create default data for the new type
                      const newData: Record<string, unknown> = { ...node.data };

                      // Add type-specific default properties
                      if (newType === 'Loop' && !newData.exitCondition) {
                        newData.exitCondition =
                          '(session) => {\n  // Exit condition\n  return false;\n}';
                      } else if (newType === 'Subroutine') {
                        if (!newData.initWith) {
                          newData.initWith = '(session) => ({})';
                        }
                        if (!newData.templateId) {
                          newData.templateId = '';
                        }
                      }

                      // Update the template
                      updateTemplate(node.id, {
                        type: newType,
                        data: newData,
                      });
                    }
                  }}
                >
                  {!node.parentId ? (
                    // Root node can only be a container type
                    <>
                      <option value="Linear">Linear</option>
                      <option value="Loop">Loop</option>
                      <option value="Subroutine">Subroutine</option>
                    </>
                  ) : (
                    // Non-root node can be any type
                    <>
                      <option value={node.type}>{node.type}</option>
                      {!['Linear', 'Loop', 'Subroutine'].includes(
                        node.type,
                      ) && (
                        // If not already a container, show container options
                        <>
                          <option value="Linear">Linear</option>
                          <option value="Loop">Loop</option>
                          <option value="Subroutine">Subroutine</option>
                        </>
                      )}
                    </>
                  )}
                </select>
              ) : (
                node.type
              )}
            </div>
            {isContainer && (
              <button
                className="p-1 text-xs bg-gray-200 rounded hover:bg-gray-300"
                onClick={toggleExpand}
                title={isExpanded ? 'Collapse' : 'Expand'}
              >
                {isExpanded ? '−' : '+'}
              </button>
            )}
          </div>

          {/* Template content */}
          <div className="template-content">{renderContent()}</div>

          {/* Move and delete buttons at the bottom - only for non-container nodes */}
          {node.parentId && !isContainer && (
            <div className="flex space-x-1 mt-3 justify-end">
              <button
                className="p-1 text-xs bg-gray-200 rounded hover:bg-gray-300"
                onClick={handleMoveUp}
                title="Move Up"
              >
                ↑
              </button>
              <button
                className="p-1 text-xs bg-gray-200 rounded hover:bg-gray-300"
                onClick={handleMoveDown}
                title="Move Down"
              >
                ↓
              </button>
              <button
                className="p-1 text-xs bg-red-200 rounded hover:bg-red-300"
                onClick={handleDelete}
                title="Delete"
              >
                ×
              </button>
            </div>
          )}
        </div>

        {/* Children container within the parent container */}
        {isContainer && isExpanded && (
          <>
            <div className="template-children mt-4 mb-3">
              <div className="bg-white rounded-lg p-3 border border-gray-200">
                {children.map((child) => (
                  <TemplateNodeComponent
                    key={child.id}
                    node={child}
                    isSelected={child.id === selectedId}
                    onSelect={() => selectTemplate(child.id)}
                    level={
                      0
                    } /* Reset level since we're using visual containment */
                  />
                ))}

                {children.length === 0 && (
                  <div className="text-sm text-gray-400 italic my-2 text-center">
                    No child templates added
                  </div>
                )}
              </div>

              {/* Add template buttons at the bottom */}
              {renderAddTemplateMenu()}
            </div>
          </>
        )}

        {/* For container templates, add buttons at the very bottom of the container */}
        {isContainer && node.parentId && (
          <div className="flex space-x-1 mt-3 justify-end">
            <button
              className="p-1 text-xs bg-gray-200 rounded hover:bg-gray-300"
              onClick={handleMoveUp}
              title="Move Up"
            >
              ↑
            </button>
            <button
              className="p-1 text-xs bg-gray-200 rounded hover:bg-gray-300"
              onClick={handleMoveDown}
              title="Move Down"
            >
              ↓
            </button>
            <button
              className="p-1 text-xs bg-red-200 rounded hover:bg-red-300"
              onClick={handleDelete}
              title="Delete"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default TemplateNodeComponent;
