import React from 'react';
import { useTemplateStore } from '../utils/templateStore';
import TemplateNodeComponent from './TemplateNode';

/**
 * Root component for template visualization
 */
const TemplateContainer: React.FC = () => {
  const { templates, selectedId, addTemplate, selectTemplate } =
    useTemplateStore();

  // Get the root node (should be a LinearTemplate)
  const rootNode = templates.find((t) => !t.parentId);

  if (!rootNode) {
    return (
      <div className="flex justify-center items-center h-full w-full">
        <div className="bg-gray-100 p-6 rounded-lg shadow-md">
          <h2 className="text-xl font-bold mb-4">No root template found</h2>
          <button
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            onClick={() => addTemplate(null, 'Linear')}
          >
            Create Root Template
          </button>
        </div>
      </div>
    );
  }

  // Show the root node and its children
  return (
    <div className="template-container p-4 overflow-auto h-full">
      <TemplateNodeComponent
        node={rootNode}
        isSelected={selectedId === rootNode.id}
        onSelect={() => selectTemplate(rootNode.id)}
        level={0}
      />
    </div>
  );
};

export default TemplateContainer;
