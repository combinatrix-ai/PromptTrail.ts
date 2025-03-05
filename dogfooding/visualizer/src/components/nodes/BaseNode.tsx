import { useState, ReactNode, FC } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

interface BaseNodeProps extends NodeProps {
  data: {
    label?: string;
    parentId?: string; // ID of parent container if this is a child node
    onDelete?: () => void; // Function to handle deletion
    onUpdate?: (data: unknown) => void; // Function to handle updates
    [key: string]: unknown;
  };
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  children?: ReactNode;
  editableContent?: ReactNode; // Editable fields when in edit mode
}

const BaseNode: FC<BaseNodeProps> = ({
  data,
  className = 'node',
  headerClassName = 'node-header',
  contentClassName = 'node-content',
  children,
  editableContent,
}) => {
  const { onDelete, parentId, onUpdate } = data;
  const [isEditing, setIsEditing] = useState(false);

  const toggleEditing = () => {
    setIsEditing(!isEditing);
  };

  return (
    <div className={className}>
      <Handle type="target" position={Position.Top} />

      <div className={headerClassName}>
        <span>{data.label || 'Node'}</span>
        <div className="node-actions">
          {onUpdate && (
            <button
              onClick={toggleEditing}
              className="edit-node-btn mr-1"
              title={isEditing ? 'View Mode' : 'Edit Mode'}
              type="button"
            >
              {isEditing ? '✓' : '✎'}
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="delete-node-btn"
              title="Delete Node"
              type="button"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className={contentClassName}>
        {isEditing && editableContent ? editableContent : children}
        {parentId && (
          <div className="text-xs text-gray-500 mt-2">Child of: {parentId}</div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
};

export default BaseNode;
