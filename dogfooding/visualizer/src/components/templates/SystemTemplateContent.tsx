import React, { useState, KeyboardEvent, FC } from 'react';
import { useTemplateStore } from '../../utils/templateStore';

interface SystemTemplateContentProps {
  content: string;
  nodeId?: string;
}

/**
 * Component to display System template content with in-place editing
 */
const SystemTemplateContent: FC<SystemTemplateContentProps> = ({
  content,
  nodeId,
}) => {
  const { updateTemplate } = useTemplateStore();
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(content || '');

  const handleClick = () => {
    setIsEditing(true);
  };

  const handleBlur = () => {
    if (nodeId && editedContent !== content) {
      updateTemplate(nodeId, { data: { content: editedContent } });
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleBlur();
    } else if (e.key === 'Escape') {
      setEditedContent(content || '');
      setIsEditing(false);
    }
  };

  return (
    <div className="system-template-content">
      <div className="text-xs text-gray-500 mb-1">Content:</div>
      {isEditing ? (
        <textarea
          className="text-sm p-2 bg-white rounded border border-blue-500 w-full focus:outline-none focus:ring-2 focus:ring-blue-300"
          value={editedContent}
          onChange={(e) => setEditedContent(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          rows={3}
          placeholder="Enter system content..."
        />
      ) : (
        <div
          className="text-sm p-2 bg-white rounded border border-blue-200 cursor-pointer hover:border-blue-500"
          onClick={handleClick}
        >
          {content ? (
            content
          ) : (
            <span className="italic text-gray-400">Click to edit content</span>
          )}
        </div>
      )}
    </div>
  );
};

export default SystemTemplateContent;
