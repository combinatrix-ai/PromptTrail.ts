import React, { FC, useCallback } from 'react';
import { NodeProps } from 'reactflow';
import CompositeNode from './CompositeNode';
import { useVisualizerStore } from '../../utils/store';

interface LinearNodeData {
  id: string;
  childIds: string[];
  label?: string;
}

const LinearNode: FC<NodeProps<LinearNodeData>> = ({ data, ...props }) => {
  const {
    isNodeExpanded,
    toggleNodeExpansion,
    nodes,
    addNode,
    addChildToNode,
  } = useVisualizerStore();
  const expanded = isNodeExpanded(data.id);

  const handleAddChild = useCallback(() => {
    // Let the user choose which type to add
    const type = window.prompt(
      'Choose template type to add (System, User, or Assistant):',
      'System',
    );

    // If user cancels or enters invalid type, abort
    if (!type || !['System', 'User', 'Assistant'].includes(type)) {
      return;
    }

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

  // Get the child nodes based on childIds
  const childNodes = (data.childIds || [])
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is NonNullable<typeof node> => node !== undefined);

  return (
    <CompositeNode
      data={{
        ...data,
        label: data.label || 'Linear Template',
        expanded,
        onToggleExpand: () => toggleNodeExpansion(data.id),
        onAddChild: handleAddChild,
        children: (
          <div className="child-nodes-container">
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
      className="composite-node node-linear"
      {...props}
    />
  );
};

export default LinearNode;
