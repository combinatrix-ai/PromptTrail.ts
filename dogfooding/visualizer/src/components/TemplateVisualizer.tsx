import React, { useCallback, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Node,
  Edge,
  NodeTypes,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  ConnectionLineType,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { useVisualizerStore } from '../utils/store';

// Import custom node components
import SystemNode from './nodes/SystemNode';
import UserNode from './nodes/UserNode';
import AssistantNode from './nodes/AssistantNode';
import LinearNode from './nodes/LinearNode';
import LoopNode from './nodes/LoopNode';
import SubroutineNode from './nodes/SubroutineNode';

interface TemplateVisualizerProps {
  onNodeSelect?: (nodeId: string | null) => void;
}

// Define custom node types mapping
const nodeTypes: NodeTypes = {
  System: SystemNode,
  User: UserNode,
  Assistant: AssistantNode,
  Linear: LinearNode,
  Loop: LoopNode,
  Subroutine: SubroutineNode,
};

// Initial starter template
const initialNodes: Node[] = [
  {
    id: 'node-1',
    type: 'Linear',
    position: { x: 250, y: 50 },
    data: { childIds: ['system-1'] },
  },
  {
    id: 'system-1',
    type: 'System',
    position: { x: 250, y: 150 },
    data: {
      content:
        'You are a helpful AI assistant. Be concise and friendly in your responses.',
      parentId: 'node-1',
    },
  },
];

const initialEdges: Edge[] = [
  { id: 'edge-1-2', source: 'node-1', target: 'system-1', type: 'smoothstep' },
];

const TemplateVisualizer: React.FC<TemplateVisualizerProps> = ({
  onNodeSelect,
}) => {
  // Get store functions
  const { setNodes: setStoreNodes, setEdges: setStoreEdges } =
    useVisualizerStore();

  // Use local state for nodes and edges
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Get nodes and edges from store
  const storeNodes = useVisualizerStore((state) => state.nodes);
  const storeEdges = useVisualizerStore((state) => state.edges);

  // Use store nodes and edges if available
  useEffect(() => {
    if (storeNodes.length > 0) {
      setNodes(storeNodes);
    } else if (nodes.length === 0) {
      // Initialize with starter template if no nodes in store or local state
      setNodes(initialNodes);
      setStoreNodes(initialNodes);
    }

    if (storeEdges.length > 0) {
      setEdges(storeEdges);
    } else if (edges.length === 0) {
      setEdges(initialEdges);
      setStoreEdges(initialEdges);
    }
  }, [
    storeNodes,
    storeEdges,
    setNodes,
    setEdges,
    setStoreNodes,
    setStoreEdges,
  ]);

  // Handle node changes
  const handleNodesChange = useCallback(
    (changes: any) => {
      onNodesChange(changes);
      // Update store after local state changes
      setTimeout(() => {
        setStoreNodes(nodes);
      }, 0);
    },
    [nodes, onNodesChange, setStoreNodes],
  );

  // Handle edge changes
  const handleEdgesChange = useCallback(
    (changes: any) => {
      onEdgesChange(changes);
      // Update store after local state changes
      setTimeout(() => {
        setStoreEdges(edges);
      }, 0);
    },
    [edges, onEdgesChange, setStoreEdges],
  );

  // Handle connection of nodes
  const handleConnect = useCallback(
    (connection: Connection) => {
      const newEdge = { ...connection, type: 'smoothstep' };
      setEdges((eds) => {
        const updatedEdges = addEdge(newEdge, eds);
        setStoreEdges(updatedEdges);
        return updatedEdges;
      });

      // Update parent-child relationship in nodes
      if (connection.source && connection.target) {
        const sourceNode = nodes.find((n) => n.id === connection.source);
        const targetNode = nodes.find((n) => n.id === connection.target);

        if (
          sourceNode &&
          targetNode &&
          (sourceNode.type === 'Linear' || sourceNode.type === 'Loop')
        ) {
          // Add child to parent
          const updatedNodes = nodes.map((node) => {
            if (node.id === sourceNode.id) {
              return {
                ...node,
                data: {
                  ...node.data,
                  childIds: [...(node.data.childIds || []), targetNode.id],
                },
              };
            }
            if (node.id === targetNode.id) {
              return {
                ...node,
                data: {
                  ...node.data,
                  parentId: sourceNode.id,
                },
              };
            }
            return node;
          });

          setNodes(updatedNodes);
          setStoreNodes(updatedNodes);
        }
      }
    },
    [nodes, setEdges, setNodes, setStoreEdges, setStoreNodes],
  );

  // Handle node click
  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (onNodeSelect) {
        onNodeSelect(node.id);
      }
    },
    [onNodeSelect],
  );

  // Add a new node (specifically Assistant node)
  const handleAddNode = useCallback(() => {
    const newNode = {
      id: `assistant-${Date.now()}`,
      type: 'Assistant',
      position: { x: 250, y: nodes.length * 100 + 100 },
      data: { model: 'gpt-4o-mini' },
    };
    const updatedNodes = [...nodes, newNode];
    setNodes(updatedNodes);
    setStoreNodes(updatedNodes);
  }, [nodes, setNodes, setStoreNodes]);

  // Add controls for adding nodes directly in the visualizer
  const ControlsMenu = () => (
    <div className="absolute top-2 right-2 z-10 bg-white p-2 rounded shadow-md">
      <button className="btn btn-sm btn-success" onClick={handleAddNode}>
        + Assistant
      </button>
    </div>
  );

  return (
    <div className="h-full w-full relative">
      <ControlsMenu />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={handleNodeClick}
        nodeTypes={nodeTypes}
        connectionLineType={ConnectionLineType.SmoothStep}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
};

export default TemplateVisualizer;
