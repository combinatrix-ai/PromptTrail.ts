import React, { useState, useCallback } from 'react';
import { NodeProps } from 'reactflow';
import BaseNode from './BaseNode';
import { useVisualizerStore } from '../../utils/store';

interface SubroutineNodeData {
  templateId?: string;
  initWith: string;
  squashWith?: string;
  label?: string;
  childIds?: string[];
  parentId?: string;
}

const SubroutineNode: React.FC<NodeProps<SubroutineNodeData>> = ({
  data,
  ...props
}) => {
  const { updateNode } = useVisualizerStore();

  // Create state for editable fields
  const [draftData, setDraftData] = useState({
    templateId: data.templateId || '',
    initWith: data.initWith || '(session) => ({})',
    squashWith: data.squashWith || '',
  });

  const handleChange =
    (field: keyof typeof draftData) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraftData((prev) => ({ ...prev, [field]: e.target.value }));
    };

  const handleUpdate = useCallback(() => {
    if (props.id) {
      updateNode(props.id, {
        data: {
          ...data,
          templateId: draftData.templateId || undefined,
          initWith: draftData.initWith,
          squashWith: draftData.squashWith || undefined,
        },
      });
    }
  }, [props.id, data, draftData, updateNode]);

  return (
    <BaseNode
      data={{
        ...data,
        label: data.label || 'Subroutine',
        onUpdate: handleUpdate,
        onDelete: data.parentId ? () => {} : undefined,
      }}
      className="node node-subroutine"
      {...props}
      editableContent={
        <div className="text-sm">
          <div className="mb-2">
            <label className="block text-xs font-medium mb-1">
              Template ID:
            </label>
            <input
              type="text"
              className="w-full p-1 text-xs border rounded"
              value={draftData.templateId}
              onChange={handleChange('templateId')}
              placeholder="Enter template ID..."
            />
          </div>

          <div className="mb-2">
            <label className="block text-xs font-medium mb-1">
              Init Function:
            </label>
            <textarea
              className="w-full p-1 text-xs border rounded"
              value={draftData.initWith}
              onChange={handleChange('initWith')}
              rows={3}
              placeholder="Enter init function..."
            />
          </div>

          <div className="mb-2">
            <label className="block text-xs font-medium mb-1">
              Squash Function (optional):
            </label>
            <textarea
              className="w-full p-1 text-xs border rounded"
              value={draftData.squashWith}
              onChange={handleChange('squashWith')}
              rows={3}
              placeholder="Enter squash function..."
            />
          </div>

          <div className="flex justify-end">
            <button
              className="px-1 py-0.5 text-xs bg-green-500 text-white rounded"
              onClick={handleUpdate}
            >
              Save
            </button>
          </div>
        </div>
      }
    >
      <div className="text-sm">
        <div className="font-medium mb-1">Template ID:</div>
        <div className="text-xs mb-2">{data.templateId || 'Not specified'}</div>

        <div className="font-medium mb-1">Init Function:</div>
        <div className="text-xs mb-2 bg-gray-100 p-1 rounded overflow-hidden">
          {data.initWith && data.initWith.length > 60
            ? `${data.initWith.substring(0, 60)}...`
            : data.initWith || '(session) => ({})'}
        </div>

        {data.squashWith && (
          <>
            <div className="font-medium mb-1">Squash Function:</div>
            <div className="text-xs bg-gray-100 p-1 rounded overflow-hidden">
              {data.squashWith.length > 60
                ? `${data.squashWith.substring(0, 60)}...`
                : data.squashWith}
            </div>
          </>
        )}

        {data.childIds && data.childIds.length > 0 && (
          <div className="mt-2 text-xs text-blue-600">
            Contains {data.childIds.length} child templates
          </div>
        )}
      </div>
    </BaseNode>
  );
};

export default SubroutineNode;
