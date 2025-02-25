import React, { useState } from 'react';
import { useTemplateStore } from '../../utils/templateStore';

interface UserTemplateContentProps {
  description: string;
  defaultValue?: string;
  nodeId?: string;
}

/**
 * Component to display User template content with in-place editing
 */
const UserTemplateContent: React.FC<UserTemplateContentProps> = ({
  description,
  defaultValue,
  nodeId,
}) => {
  const { updateTemplate } = useTemplateStore();

  // States for editing fields
  const [editingField, setEditingField] = useState<
    'description' | 'default' | null
  >(null);
  const [editedDescription, setEditedDescription] = useState(description || '');
  const [editedDefault, setEditedDefault] = useState(defaultValue || '');

  const handleClick = (field: 'description' | 'default') => {
    if (field === 'description') {
      setEditedDescription(description || '');
    } else {
      setEditedDefault(defaultValue || '');
    }
    setEditingField(field);
  };

  const handleBlur = () => {
    if (nodeId && editingField) {
      const updates: any = {};

      if (editingField === 'description' && editedDescription !== description) {
        updates.description = editedDescription;
      } else if (editingField === 'default' && editedDefault !== defaultValue) {
        updates.default = editedDefault || undefined;
      }

      if (Object.keys(updates).length > 0) {
        updateTemplate(nodeId, { data: updates });
      }
    }
    setEditingField(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleBlur();
    } else if (e.key === 'Escape') {
      setEditedDescription(description || '');
      setEditedDefault(defaultValue || '');
      setEditingField(null);
    }
  };

  return (
    <div className="user-template-content">
      <div className="text-xs text-gray-500 mb-1">Description:</div>
      {editingField === 'description' ? (
        <textarea
          className="text-sm p-2 bg-white rounded border border-green-500 w-full focus:outline-none focus:ring-2 focus:ring-green-300 mb-2"
          value={editedDescription}
          onChange={(e) => setEditedDescription(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          rows={2}
          placeholder="Enter user description..."
        />
      ) : (
        <div
          className="text-sm p-2 bg-white rounded border border-green-200 mb-2 cursor-pointer hover:border-green-500"
          onClick={() => handleClick('description')}
        >
          {description || (
            <span className="italic text-gray-400">
              Click to add description
            </span>
          )}
        </div>
      )}

      <div className="text-xs text-gray-500 mb-1">Default Value:</div>
      {editingField === 'default' ? (
        <textarea
          className="text-sm p-2 bg-white rounded border border-green-500 w-full focus:outline-none focus:ring-2 focus:ring-green-300"
          value={editedDefault}
          onChange={(e) => setEditedDefault(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          rows={2}
          placeholder="Enter default value..."
        />
      ) : (
        <div
          className="text-sm p-2 bg-white rounded border border-green-200 cursor-pointer hover:border-green-500"
          onClick={() => handleClick('default')}
        >
          {defaultValue ? (
            defaultValue
          ) : (
            <span className="italic text-gray-400">
              Click to add default value
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default UserTemplateContent;
