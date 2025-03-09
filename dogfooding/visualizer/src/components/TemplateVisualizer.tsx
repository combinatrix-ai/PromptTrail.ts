import React, { useCallback, useEffect, MouseEvent, FC } from 'react';
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
import { useSessionStore } from '../utils/sessionStore';

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

const TemplateVisualizer: FC<TemplateVisualizerProps> = ({ onNodeSelect }) => {
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
    (changes: unknown) => {
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
    (changes: unknown) => {
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
    (_: MouseEvent, node: Node) => {
      if (onNodeSelect) {
        onNodeSelect(node.id);
      }
    },
    [onNodeSelect],
  );

  // Add a new node
  const handleAddNode = useCallback(
    (nodeType: 'Assistant' | 'User' | 'System') => {
      let newNode: Node;

      switch (nodeType) {
        case 'Assistant':
          newNode = {
            id: `assistant-${Date.now()}`,
            type: 'Assistant',
            position: { x: 250, y: nodes.length * 100 + 100 },
            data: { model: 'gpt-4o-mini' },
          };
          break;
        case 'User':
          newNode = {
            id: `user-${Date.now()}`,
            type: 'User',
            position: { x: 250, y: nodes.length * 100 + 100 },
            data: { description: 'Your message:' },
          };
          break;
        case 'System':
          newNode = {
            id: `system-${Date.now()}`,
            type: 'System',
            position: { x: 250, y: nodes.length * 100 + 100 },
            data: { content: 'You are a helpful AI assistant.' },
          };
          break;
        default:
          return;
      }

      const updatedNodes = [...nodes, newNode];
      setNodes(updatedNodes);
      setStoreNodes(updatedNodes);
    },
    [nodes, setNodes, setStoreNodes],
  );

  // Get session store state
  const { openaiApiKey, isRunning } = useSessionStore();

  // Handle running the template
  const handleRunTemplate = useCallback(() => {
    // Redirect to the session panel
    const sessionPanel = document.querySelector('.session-panel-container');
    if (sessionPanel) {
      sessionPanel.scrollIntoView({ behavior: 'smooth' });
    }

    // Find the run button in the session panel and click it
    const runButton = document.querySelector(
      '.session-panel button:not([disabled])',
    );
    if (runButton && runButton instanceof HTMLButtonElement) {
      runButton.click();
    }
  }, []);

  // Add controls for adding nodes directly in the visualizer
  const ControlsMenu = () => (
    <div className="absolute top-2 right-2 z-10 bg-white p-2 rounded shadow-md">
      <div className="flex gap-2 mb-2">
        <button
          className="btn btn-sm btn-success"
          onClick={() => handleAddNode('Assistant')}
        >
          + Assistant
        </button>
        <button
          className="btn btn-sm btn-info"
          onClick={() => handleAddNode('User')}
        >
          + User
        </button>
        <button
          className="btn btn-sm btn-warning"
          onClick={() => handleAddNode('System')}
        >
          + System
        </button>
      </div>
      <button
        className={`btn btn-sm w-full ${openaiApiKey && !isRunning ? 'btn-primary' : 'btn-disabled'}`}
        onClick={handleRunTemplate}
        disabled={!openaiApiKey || isRunning}
        title={
          !openaiApiKey
            ? 'Set OpenAI API key first'
            : isRunning
              ? 'Session is running'
              : 'Run template'
        }
      >
        {isRunning ? 'Running...' : '▶ Run'}
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
