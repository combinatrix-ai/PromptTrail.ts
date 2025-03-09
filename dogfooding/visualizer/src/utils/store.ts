import { create } from 'zustand';
import { Node, Edge } from 'reactflow';

// Interface for node expansion state
interface NodeExpansionState {
  [nodeId: string]: boolean;
}

interface VisualizerState {
  // Template graph data
  nodes: Node[];
  edges: Edge[];
  selectedNodeId: string | null;

  // Node expansion state
  expandedNodes: NodeExpansionState;

  // Code editor state
  code: string;

  // Actions
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  addNode: (node: Omit<Node, 'id'> & { id?: string }) => string;
  updateNode: (id: string, data: Partial<Node>) => void;
  removeNode: (id: string) => void;
  addEdge: (source: string, target: string) => void;
  removeEdge: (id: string) => void;
  selectNode: (id: string | null) => void;
  setCode: (code: string) => void;

  // Graph operations
  clearGraph: () => void;
  setGraph: (graph: { nodes: Node[]; edges: Edge[] }) => void;

  // Container node operations
  toggleNodeExpansion: (nodeId: string) => void;
  isNodeExpanded: (nodeId: string) => boolean;
  addChildToNode: (parentId: string, childId: string) => void;
  removeChildFromNode: (parentId: string, childId: string) => void;

  // React Flow handlers
  onNodesChange: (changes: unknown) => void;
  onEdgesChange: (changes: unknown) => void;
}

// Create the store
export const useVisualizerStore = create<VisualizerState>((set, get) => ({
  // Initial state
  nodes: [],
  edges: [],
  selectedNodeId: null,
  expandedNodes: {},
  code: '',

  // Actions
  setNodes: (nodes) => set({ nodes }),

  setEdges: (edges) => set({ edges }),

  addNode: (node) => {
    const id = node.id || `node-${Math.random().toString(36).substring(2, 9)}`;
    const newNode = { ...node, id } as Node;
    set((state) => ({ nodes: [...state.nodes, newNode] }));
    return id; // Return the ID of the new node
  },

  updateNode: (id, data) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === id ? { ...node, ...data } : node,
      ),
    })),

  removeNode: (id) =>
    set((state) => ({
      nodes: state.nodes.filter((node) => node.id !== id),
      edges: state.edges.filter(
        (edge) => edge.source !== id && edge.target !== id,
      ),
      selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
    })),

  addEdge: (source, target) =>
    set((state) => {
      const id = `edge-${Math.random().toString(36).substring(2, 9)}`;
      const newEdge: Edge = { id, source, target, type: 'smoothstep' };
      return { edges: [...state.edges, newEdge] };
    }),

  removeEdge: (id) =>
    set((state) => ({
      edges: state.edges.filter((edge) => edge.id !== id),
    })),

  selectNode: (id) => set({ selectedNodeId: id }),

  setCode: (code) => set({ code }),

  clearGraph: () =>
    set({
      nodes: [],
      edges: [],
      selectedNodeId: null,
      expandedNodes: {},
    }),

  setGraph: (graph) =>
    set({
      nodes: graph.nodes,
      edges: graph.edges,
      selectedNodeId: null,
    }),

  // Container node operations
  toggleNodeExpansion: (nodeId: string) =>
    set((state) => ({
      expandedNodes: {
        ...state.expandedNodes,
        [nodeId]: !state.expandedNodes[nodeId],
      },
    })),

  isNodeExpanded: (nodeId: string) => {
    // Default to true if not explicitly set
    return get().expandedNodes[nodeId] !== false;
  },

  addChildToNode: (parentId: string, childId: string) =>
    set((state) => {
      const nodes = [...state.nodes];
      const parentNode = nodes.find((node) => node.id === parentId);

      if (
        parentNode &&
        (parentNode.type === 'Linear' || parentNode.type === 'Loop')
      ) {
        const updatedParentNode = {
          ...parentNode,
          data: {
            ...parentNode.data,
            childIds: [...(parentNode.data.childIds || []), childId],
          },
        };

        return {
          nodes: nodes.map((node) =>
            node.id === parentId ? updatedParentNode : node,
          ),
        };
      }

      return { nodes };
    }),

  removeChildFromNode: (parentId: string, childId: string) =>
    set((state) => {
      const nodes = [...state.nodes];
      const parentNode = nodes.find((node) => node.id === parentId);

      if (
        parentNode &&
        (parentNode.type === 'Linear' || parentNode.type === 'Loop')
      ) {
        const updatedParentNode = {
          ...parentNode,
          data: {
            ...parentNode.data,
            childIds: (parentNode.data.childIds || []).filter(
              (id: string) => id !== childId,
            ),
          },
        };

        return {
          nodes: nodes.map((node) =>
            node.id === parentId ? updatedParentNode : node,
          ),
        };
      }

      return { nodes };
    }),

  // React Flow handlers
  onNodesChange: () =>
    set((state) => {
      const newNodes = [...state.nodes];
      // Apply changes to nodes (simplified)
      return { nodes: newNodes };
    }),

  onEdgesChange: () =>
    set((state) => {
      const newEdges = [...state.edges];
      // Apply changes to edges (simplified)
      return { edges: newEdges };
    }),
}));
