import React, { useState, useCallback, FC } from 'react';
import { NodeProps } from 'reactflow';
import CompositeNode from './CompositeNode';
import { useVisualizerStore } from '../../utils/store';

interface LoopNodeData {
  id: string;
  childIds: string[];
  exitCondition: string;
  label?: string;
}

const LoopNode: FC<NodeProps<LoopNodeData>> = ({ data, ...props }) => {
  const {
    isNodeExpanded,
    toggleNodeExpansion,
    nodes,
    addNode,
    addChildToNode,
    updateNode,
  } = useVisualizerStore();
  const expanded = isNodeExpanded(data.id);

  // State for editing exit condition
  const [isEditingCondition, setIsEditingCondition] = useState(false);
  const [draftExitCondition, setDraftExitCondition] = useState(
    data.exitCondition || '(session) => false',
  );

  const handleAddChild = useCallback(() => {
    // Types of nodes that can be added as children
    const nodeTypes: ('System' | 'User' | 'Assistant')[] = [
      'System',
      'User',
      'Assistant',
    ];
    const type = nodeTypes[Math.floor(Math.random() * nodeTypes.length)];

    // Create node data based on type
    let nodeData: Record<string, unknown> = {
      parentId: data.id, // Add reference to parent
    };

    if (type === 'System') {
      nodeData = { ...nodeData, content: 'New system message' };
    } else if (type === 'User') {
      nodeData = { ...nodeData, description: 'User input', default: '' };
    } else if (type === 'Assistant') {
      nodeData = { ...nodeData, model: 'gpt-4o-mini' };
    }

    // Create the child node
    const childNode = {
      type,
      position: { x: 0, y: 0 }, // Position will be adjusted by the layout
      data: nodeData,
    };

    // Add the node and connect it to this container
    const childId = addNode(childNode);
    addChildToNode(data.id, childId);
  }, [data.id, addNode, addChildToNode]);

  const handleUpdateExitCondition = () => {
    if (props.id) {
      updateNode(props.id, {
        data: { ...data, exitCondition: draftExitCondition },
      });
      setIsEditingCondition(false);
    }
  };

  // Get the child nodes based on childIds
  const childNodes = (data.childIds || [])
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is NonNullable<typeof node> => node !== undefined);

  return (
    <CompositeNode
      data={{
        ...data,
        label: data.label || 'Loop Template',
        expanded,
        onToggleExpand: () => toggleNodeExpansion(data.id),
        onAddChild: handleAddChild,
        children: (
          <div className="child-nodes-container">
            <div className="exit-condition">
              <div className="flex justify-between items-center mb-1">
                <div className="exit-condition-label">Exit Condition:</div>
                <button
                  onClick={() => setIsEditingCondition(!isEditingCondition)}
                  className="text-xs px-1 rounded hover:bg-gray-200"
                >
                  {isEditingCondition ? 'View' : 'Edit'}
                </button>
              </div>

              {isEditingCondition ? (
                <div className="mb-2">
                  <textarea
                    className="w-full p-1 text-xs border rounded"
                    value={draftExitCondition}
                    onChange={(e) => setDraftExitCondition(e.target.value)}
                    rows={3}
                    placeholder="Enter exit condition function..."
                  />
                  <div className="flex justify-end mt-1">
                    <button
                      className="px-1 py-0.5 text-xs bg-green-500 text-white rounded"
                      onClick={handleUpdateExitCondition}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="exit-condition-code">
                  {data.exitCondition && data.exitCondition.length > 80
                    ? `${data.exitCondition.substring(0, 80)}...`
                    : data.exitCondition || '(session) => false'}
                </div>
              )}
            </div>

            <div className="child-nodes-label">Child Templates:</div>
            {childNodes.length > 0 ? (
              <div className="child-nodes">
                {childNodes.map((node, index) => (
                  <div key={node.id} className="child-node-reference">
                    <span className="child-node-index">{index + 1}.</span>
                    <span className="child-node-type">{node.type}</span>
                    <span className="child-node-id">{node.id}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="no-children-message">No child templates</div>
            )}
          </div>
        ),
      }}
      className="composite-node node-loop"
      {...props}
    />
  );
};

export default LoopNode;
