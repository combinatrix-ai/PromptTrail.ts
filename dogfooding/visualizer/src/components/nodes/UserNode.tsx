import React, { useCallback, useState, ChangeEvent, FC } from 'react';
import { NodeProps } from 'reactflow';
import BaseNode from './BaseNode';
import { useVisualizerStore } from '../../utils/store';

interface UserNodeData {
  description: string;
  default?: string;
  validate?: string;
  onInput?: string;
  label?: string;
  parentId?: string;
}

const UserNode: FC<NodeProps<UserNodeData>> = ({ data, ...props }) => {
  const { removeNode, removeChildFromNode, updateNode } = useVisualizerStore();

  // Create state for editable fields
  const [draftData, setDraftData] = useState({
    description: data.description || '',
    default: data.default || '',
    validate: data.validate || '',
    onInput: data.onInput || '',
  });

  const handleDelete = useCallback(() => {
    if (data.parentId && props.id) {
      // Remove this node from its parent's children
      removeChildFromNode(data.parentId, props.id);
      // Remove the node itself
      removeNode(props.id);
    }
  }, [props.id, data.parentId, removeNode, removeChildFromNode]);

  const handleUpdate = useCallback(
    (updatedData: Partial<UserNodeData>) => {
      if (props.id) {
        updateNode(props.id, { data: { ...data, ...updatedData } });
      }
    },
    [props.id, data, updateNode],
  );

  const handleChange =
    (field: keyof typeof draftData) =>
    (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraftData((prev) => ({ ...prev, [field]: e.target.value }));
    };

  const handleSave = () => {
    handleUpdate({
      description: draftData.description,
      default: draftData.default || undefined,
      validate: draftData.validate || undefined,
      onInput: draftData.onInput || undefined,
    });
  };

  return (
    <BaseNode
      data={{
        ...data,
        label: data.label || 'User',
        onDelete: data.parentId ? handleDelete : undefined,
        onUpdate: handleSave,
      }}
      className="node node-user"
      {...props}
      editableContent={
        <div className="text-sm">
          <div className="mb-1">
            <label className="block text-xs font-medium mb-1">
              Description:
            </label>
            <input
              type="text"
              className="w-full p-1 text-xs border rounded"
              value={draftData.description}
              onChange={handleChange('description')}
              placeholder="Enter description..."
            />
          </div>

          <div className="mb-1">
            <label className="block text-xs font-medium mb-1">
              Default Value:
            </label>
            <input
              type="text"
              className="w-full p-1 text-xs border rounded"
              value={draftData.default}
              onChange={handleChange('default')}
              placeholder="Enter default value..."
            />
          </div>

          <div className="mb-1">
            <label className="block text-xs font-medium mb-1">
              Validate Function:
            </label>
            <textarea
              className="w-full p-1 text-xs border rounded"
              value={draftData.validate}
              onChange={handleChange('validate')}
              rows={2}
              placeholder="Enter validation function..."
            />
          </div>

          <div className="mb-2">
            <label className="block text-xs font-medium mb-1">
              OnInput Function:
            </label>
            <textarea
              className="w-full p-1 text-xs border rounded"
              value={draftData.onInput}
              onChange={handleChange('onInput')}
              rows={2}
              placeholder="Enter onInput function..."
            />
          </div>

          <div className="flex justify-end">
            <button
              className="px-1 py-0.5 text-xs bg-green-500 text-white rounded"
              onClick={handleSave}
            >
              Save
            </button>
          </div>
        </div>
      }
    >
      <div className="text-sm">
        <div className="font-medium mb-1">Description:</div>
        <div className="text-xs mb-2">
          {data.description.length > 80
            ? `${data.description.substring(0, 80)}...`
            : data.description}
        </div>

        {data.default !== undefined && (
          <>
            <div className="font-medium mb-1">Default:</div>
            <div className="text-xs mb-2">
              {data.default.length > 30
                ? `${data.default.substring(0, 30)}...`
                : data.default}
            </div>
          </>
        )}

        {data.validate && (
          <div className="text-xs italic">Has validate function</div>
        )}

        {data.onInput && (
          <div className="text-xs italic">Has onInput function</div>
        )}
      </div>
    </BaseNode>
  );
};

export default UserNode;
