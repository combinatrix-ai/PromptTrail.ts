import { useCallback, useState, ChangeEvent, FC } from 'react';
import { NodeProps } from 'reactflow';
import BaseNode from './BaseNode';
import { useVisualizerStore } from '../../utils/store';

interface SystemNodeData {
  content: string;
  label?: string;
  parentId?: string;
}

const SystemNode: FC<NodeProps<SystemNodeData>> = ({ data, ...props }) => {
  const { removeNode, removeChildFromNode, updateNode } = useVisualizerStore();
  const [draftContent, setDraftContent] = useState(data.content || '');

  const handleDelete = useCallback(() => {
    if (data.parentId && props.id) {
      // Remove this node from its parent's children
      removeChildFromNode(data.parentId, props.id);
      // Remove the node itself
      removeNode(props.id);
    }
  }, [props.id, data.parentId, removeNode, removeChildFromNode]);

  const handleUpdate = useCallback(
    (updatedData: Partial<SystemNodeData>) => {
      if (props.id) {
        updateNode(props.id, { data: { ...data, ...updatedData } });
      }
    },
    [props.id, data, updateNode],
  );

  const handleContentChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setDraftContent(e.target.value);
  };

  const handleSave = () => {
    handleUpdate({ content: draftContent });
  };

  return (
    <BaseNode
      data={{
        ...data,
        label: data.label || 'System',
        onDelete: data.parentId ? handleDelete : undefined,
        onUpdate: handleSave,
      }}
      className="node node-system"
      {...props}
      editableContent={
        <div className="text-sm">
          <textarea
            className="w-full p-1 text-sm border rounded"
            value={draftContent}
            onChange={handleContentChange}
            rows={4}
            placeholder="Enter system content..."
          />
          <div className="flex justify-end mt-1">
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
        {data.content && (
          <div>
            {data.content.length > 100
              ? `${data.content.substring(0, 100)}...`
              : data.content}
          </div>
        )}
      </div>
    </BaseNode>
  );
};

export default SystemNode;
