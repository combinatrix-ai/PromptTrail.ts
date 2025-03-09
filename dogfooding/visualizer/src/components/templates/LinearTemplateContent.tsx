import React, { useState, KeyboardEvent, FC } from 'react';
import { useTemplateStore } from '../../utils/templateStore';

interface LinearTemplateContentProps {
  name?: string;
  nodeId?: string;
}

/**
 * Component to display Linear template content with in-place editing
 */
const LinearTemplateContent: FC<LinearTemplateContentProps> = ({
  name = 'Linear Template',
  nodeId,
}) => {
  const { updateTemplate } = useTemplateStore();

  // States for editing fields
  const [editingField, setEditingField] = useState<'name' | null>(null);
  const [editedName, setEditedName] = useState(name);

  const handleNameClick = () => {
    setEditedName(name);
    setEditingField('name');
  };

  const handleBlur = () => {
    if (nodeId && editingField === 'name' && editedName !== name) {
      updateTemplate(nodeId, { data: { name: editedName } });
    }
    setEditingField(null);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleBlur();
    } else if (e.key === 'Escape') {
      setEditedName(name);
      setEditingField(null);
    }
  };

  return (
    <div className="linear-template-content">
      <div className="text-xs text-gray-500 mb-1">Name:</div>
      {editingField === 'name' ? (
        <input
          type="text"
          className="text-sm p-2 bg-white rounded border border-gray-500 w-full focus:outline-none focus:ring-2 focus:ring-gray-300 mb-2"
          value={editedName}
          onChange={(e) => setEditedName(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          placeholder="Enter template name..."
        />
      ) : (
        <div
          className="text-sm p-2 bg-white rounded border border-gray-200 cursor-pointer hover:border-gray-500 mb-2"
          onClick={handleNameClick}
        >
          {name || (
            <span className="italic text-gray-400">Click to add name</span>
          )}
        </div>
      )}
      <div className="text-sm font-medium">Linear Template</div>
    </div>
  );
};

export default LinearTemplateContent;
