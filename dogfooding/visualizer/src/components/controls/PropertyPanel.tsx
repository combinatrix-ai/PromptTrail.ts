import { FC } from 'react';
import { TemplateNode } from '../../utils/templateTypes';

interface PropertyPanelProps {
  node: TemplateNode | null;
  onNodeUpdate?: (id: string, data: Partial<TemplateNode>) => void;
}

const PropertyPanel: FC<PropertyPanelProps> = ({ node, onNodeUpdate }) => {
  if (!node) {
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
    if (onNodeUpdate && node) {
      // Use type-safe approach to update node data
      switch (node.type) {
        case 'System':
          if (key === 'content') {
            onNodeUpdate(node.id, {
              data: { ...node.data, content: value },
            });
          }
          break;
        case 'User':
          onNodeUpdate(node.id, {
            data: { ...node.data, [key]: value },
          });
          break;
        case 'Assistant':
          onNodeUpdate(node.id, {
            data: { ...node.data, [key]: value },
          });
          break;
        case 'Linear':
          // Linear nodes have childIds which we don't edit directly here
          break;
        case 'Loop':
          if (key === 'exitCondition') {
            onNodeUpdate(node.id, {
              data: { ...node.data, exitCondition: value },
            });
          }
          break;
        case 'Subroutine':
          onNodeUpdate(node.id, {
            data: { ...node.data, [key]: value },
          });
          break;
      }
    }
  };

  // Render different forms based on node type
  const renderProperties = () => {
    switch (node.type) {
      case 'System':
        return (
          <>
            <div className="property-group">
              <label className="property-label">Content</label>
              <textarea
                className="property-input h-32"
                value={node.data.content as string}
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
                value={node.data.description as string}
                onChange={(e) => handleChange('description', e.target.value)}
                placeholder="Enter description..."
              />
            </div>
            <div className="property-group">
              <label className="property-label">Default Value</label>
              <input
                type="text"
                className="property-input"
                value={(node.data.default as string) || ''}
                onChange={(e) => handleChange('default', e.target.value)}
                placeholder="Enter default value..."
              />
            </div>
            <div className="property-group">
              <label className="property-label">Validation Function</label>
              <textarea
                className="property-input h-24"
                value={(node.data.validate as string) || ''}
                onChange={(e) => handleChange('validate', e.target.value)}
                placeholder="Enter validation function..."
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
                value={(node.data.content as string) || ''}
                onChange={(e) => handleChange('content', e.target.value)}
                placeholder="Enter fixed response content..."
              />
            </div>
            <div className="property-group">
              <label className="property-label">Model</label>
              <input
                type="text"
                className="property-input"
                value={(node.data.model as string) || ''}
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
                {(node.data.childIds as string[])?.map((id, index) => (
                  <div key={id} className="mb-1">
                    {index + 1}. {id}
                  </div>
                ))}
              </div>
            </div>
            {node.type === 'Loop' && (
              <div className="property-group">
                <label className="property-label">Exit Condition</label>
                <textarea
                  className="property-input h-24"
                  value={(node.data.exitCondition as string) || ''}
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
                value={(node.data.templateId as string) || ''}
                onChange={(e) => handleChange('templateId', e.target.value)}
                placeholder="Enter template ID..."
              />
            </div>
            <div className="property-group">
              <label className="property-label">Init Function</label>
              <textarea
                className="property-input h-24"
                value={(node.data.initWith as string) || ''}
                onChange={(e) => handleChange('initWith', e.target.value)}
                placeholder="Enter init function..."
              />
            </div>
            <div className="property-group">
              <label className="property-label">
                Squash Function (optional)
              </label>
              <textarea
                className="property-input h-24"
                value={(node.data.squashWith as string) || ''}
                onChange={(e) => handleChange('squashWith', e.target.value)}
                placeholder="Enter squash function..."
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
      <div className="property-panel-header">Properties: {node.type} Node</div>
      <div className="property-panel-content">
        {renderProperties()}

        <div className="mt-6 flex justify-end space-x-2">
          <button className="btn btn-secondary">Reset</button>
          <button className="btn btn-primary">Apply</button>
        </div>
      </div>
    </div>
  );
};

export default PropertyPanel;
