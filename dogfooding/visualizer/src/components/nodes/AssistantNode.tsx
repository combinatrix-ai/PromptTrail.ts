import React, { useCallback, useState, ChangeEvent, FC } from 'react';
import { NodeProps } from 'reactflow';
import BaseNode from './BaseNode';
import { useVisualizerStore } from '../../utils/store';

interface AssistantNodeData {
  model?: string;
  content?: string;
  label?: string;
  parentId?: string;
  assistantType?: 'model' | 'content';
}

const AssistantNode: FC<NodeProps<AssistantNodeData>> = ({
  data,
  ...props
}) => {
  const { removeNode, removeChildFromNode, updateNode } = useVisualizerStore();

  // Create state for editable fields
  const [draftData, setDraftData] = useState({
    model: data.model || '',
    content: data.content || '',
    assistantType: data.assistantType || 'model',
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
    (updatedData: Partial<AssistantNodeData>) => {
      if (props.id) {
        updateNode(props.id, { data: { ...data, ...updatedData } });
      }
    },
    [props.id, data, updateNode],
  );

  const handleChange =
    (field: keyof typeof draftData) =>
    (
      e: ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) => {
      setDraftData((prev) => ({ ...prev, [field]: e.target.value }));
    };

  const handleSave = () => {
    handleUpdate({
      model:
        draftData.assistantType === 'model'
          ? draftData.model || undefined
          : undefined,
      content: draftData.content || undefined,
      assistantType: draftData.assistantType as 'model' | 'content',
    });
  };

  return (
    <BaseNode
      data={{
        ...data,
        label: data.label || 'Assistant',
        onDelete: data.parentId ? handleDelete : undefined,
        onUpdate: handleSave,
      }}
      className="node node-assistant"
      {...props}
      editableContent={
        <div className="text-sm">
          <div className="mb-2">
            <label className="block text-xs font-medium mb-1">Type:</label>
            <select
              className="w-full p-1 text-xs border rounded"
              value={draftData.assistantType}
              onChange={handleChange('assistantType')}
            >
              <option value="model">Model-based</option>
              <option value="content">Fixed Content</option>
            </select>
          </div>

          {draftData.assistantType === 'model' && (
            <div className="mb-2">
              <label className="block text-xs font-medium mb-1">Model:</label>
              <input
                type="text"
                className="w-full p-1 text-xs border rounded"
                value={draftData.model}
                onChange={handleChange('model')}
                placeholder="e.g., gpt-4o-mini"
              />
            </div>
          )}

          <div className="mb-2">
            <label className="block text-xs font-medium mb-1">
              Content (optional):
            </label>
            <textarea
              className="w-full p-1 text-xs border rounded"
              value={draftData.content}
              onChange={handleChange('content')}
              rows={3}
              placeholder="Enter fixed response content..."
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
        {data.model && (
          <div className="mb-2">
            <span className="font-medium">Model: </span>
            <span>{data.model}</span>
          </div>
        )}

        {data.content && (
          <>
            <div className="font-medium mb-1">Content:</div>
            <div className="text-xs">
              {data.content.length > 100
                ? `${data.content.substring(0, 100)}...`
                : data.content}
            </div>
          </>
        )}

        {!data.content && !data.model && (
          <div className="text-gray-500 italic">No specific configuration</div>
        )}
      </div>
    </BaseNode>
  );
};

export default AssistantNode;
