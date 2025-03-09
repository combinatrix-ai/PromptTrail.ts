import React from 'react';
import { useVisualizerStore } from '../utils/store';
import {
  TemplateNode,
  ISystemTemplateNode,
  IUserTemplateNode,
  IAssistantTemplateNode,
  ILinearTemplateNode,
  ILoopTemplateNode,
  ISubroutineTemplateNode,
} from '../utils/templateTypes';

interface NodeEditorProps {
  nodeId: string | null;
  onNodeUpdate?: (id: string, data: Partial<TemplateNode>) => void;
  onDeleteNode?: () => void;
}

const NodeEditor: React.FC<NodeEditorProps> = ({
  nodeId,
  onNodeUpdate,
  onDeleteNode,
}) => {
  const { nodes } = useVisualizerStore();
  const selectedNode = nodeId ? nodes.find((node) => node.id === nodeId) : null;

  // If no node is selected
  if (!selectedNode) {
    return (
      <div className="property-panel">
        <div className="property-panel-header">Properties</div>
        <div className="property-panel-content flex items-center justify-center text-gray-500">
          Select a node to edit its properties
        </div>
      </div>
    );
  }

  const handleChange = (key: string, value: string) => {
    if (onNodeUpdate && selectedNode) {
      const updatedNode = {
        ...selectedNode,
        data: {
          ...selectedNode.data,
          [key]: value,
        },
      };
      onNodeUpdate(selectedNode.id, updatedNode as TemplateNode);
    }
  };

  // Render different forms based on node type
  const renderProperties = () => {
    switch (selectedNode.type) {
      case 'System':
        return (
          <>
            <div className="property-group">
              <label className="property-label">Content</label>
              <textarea
                className="property-input h-32"
                value={(selectedNode as ISystemTemplateNode).data.content || ''}
                onChange={(e) => handleChange('content', e.target.value)}
                placeholder="Enter system message content..."
              />
            </div>
          </>
        );

      case 'User':
        return (
          <>
            <div className="property-group">
              <label className="property-label">Description</label>
              <input
                type="text"
                className="property-input"
                value={
                  (selectedNode as IUserTemplateNode).data.description || ''
                }
                onChange={(e) => handleChange('description', e.target.value)}
                placeholder="Enter description..."
              />
            </div>
            <div className="property-group">
              <label className="property-label">Default Value</label>
              <input
                type="text"
                className="property-input"
                value={(selectedNode as IUserTemplateNode).data.default || ''}
                onChange={(e) => handleChange('default', e.target.value)}
                placeholder="Enter default value..."
              />
            </div>
          </>
        );

      case 'Assistant':
        return (
          <>
            <div className="property-group">
              <label className="property-label">Content (optional)</label>
              <textarea
                className="property-input h-32"
                value={
                  (selectedNode as IAssistantTemplateNode).data.content || ''
                }
                onChange={(e) => handleChange('content', e.target.value)}
                placeholder="Enter fixed response content..."
              />
            </div>
            <div className="property-group">
              <label className="property-label">Model</label>
              <input
                type="text"
                className="property-input"
                value={
                  (selectedNode as IAssistantTemplateNode).data.model || ''
                }
                onChange={(e) => handleChange('model', e.target.value)}
                placeholder="e.g., gpt-4o-mini"
              />
            </div>
          </>
        );

      case 'Linear':
      case 'Loop':
        return (
          <>
            <div className="property-group">
              <label className="property-label">Child Templates</label>
              <div className="text-xs bg-gray-100 p-2 rounded">
                {(selectedNode.type === 'Linear' || selectedNode.type === 'Loop'
                  ? (selectedNode as ILinearTemplateNode | ILoopTemplateNode)
                      .data.childIds
                  : []
                ).length > 0 ? (
                  (selectedNode.type === 'Linear' ||
                  selectedNode.type === 'Loop'
                    ? (selectedNode as ILinearTemplateNode | ILoopTemplateNode)
                        .data.childIds
                    : []
                  ).map((id: string, index: number) => (
                    <div key={id} className="mb-1">
                      {index + 1}. {id}
                    </div>
                  ))
                ) : (
                  <div className="text-gray-500">No child templates</div>
                )}
              </div>
            </div>
            {selectedNode.type === 'Loop' && (
              <div className="property-group">
                <label className="property-label">Exit Condition</label>
                <textarea
                  className="property-input h-24"
                  value={
                    (selectedNode as ILoopTemplateNode).data.exitCondition || ''
                  }
                  onChange={(e) =>
                    handleChange('exitCondition', e.target.value)
                  }
                  placeholder="Enter exit condition function..."
                />
              </div>
            )}
          </>
        );

      case 'Subroutine':
        return (
          <>
            <div className="property-group">
              <label className="property-label">Template ID</label>
              <input
                type="text"
                className="property-input"
                value={
                  (selectedNode as ISubroutineTemplateNode).data.templateId ||
                  ''
                }
                onChange={(e) => handleChange('templateId', e.target.value)}
                placeholder="Enter template ID..."
              />
            </div>
            <div className="property-group">
              <label className="property-label">Init Function</label>
              <textarea
                className="property-input h-24"
                value={
                  (selectedNode as ISubroutineTemplateNode).data.initWith || ''
                }
                onChange={(e) => handleChange('initWith', e.target.value)}
                placeholder="Enter init function..."
              />
            </div>
          </>
        );

      default:
        return <div>Unknown node type</div>;
    }
  };

  return (
    <div className="property-panel">
      <div className="property-panel-header">
        Properties: {selectedNode.type} Node
      </div>
      <div className="property-panel-content">
        <div className="property-group">
          <label className="property-label">Node ID</label>
          <input
            type="text"
            className="property-input"
            value={selectedNode.id}
            disabled
          />
        </div>

        {renderProperties()}

        <div className="mt-6 flex justify-between space-x-2">
          {onDeleteNode && (
            <button className="btn btn-danger" onClick={onDeleteNode}>
              Delete Node
            </button>
          )}

          <button
            className="btn btn-primary"
            onClick={() => console.log('Node updated:', selectedNode)}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};

export default NodeEditor;
