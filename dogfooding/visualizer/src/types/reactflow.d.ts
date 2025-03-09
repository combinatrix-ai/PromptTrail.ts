declare module 'reactflow' {
  import { CSSProperties, MouseEvent, ReactNode } from 'react';

  export type NodeTypes = {
    [key: string]: React.ComponentType<NodeProps>;
  };

  export interface NodeProps<T = unknown> {
    id: string;
    type?: string;
    data: T;
    selected?: boolean;
    isConnectable?: boolean;
    xPos?: number;
    yPos?: number;
    dragging?: boolean;
    zIndex?: number;
    targetPosition?: Position;
    sourcePosition?: Position;
    style?: CSSProperties;
  }

  export enum Position {
    Left = 'left',
    Top = 'top',
    Right = 'right',
    Bottom = 'bottom',
  }

  export interface Node<T = unknown> {
    id: string;
    position: {
      x: number;
      y: number;
    };
    data: T;
    type?: string;
    style?: CSSProperties;
    className?: string;
    targetPosition?: Position;
    sourcePosition?: Position;
    hidden?: boolean;
    selected?: boolean;
    dragging?: boolean;
    draggable?: boolean;
    selectable?: boolean;
    connectable?: boolean;
    dragHandle?: string;
    width?: number | null;
    height?: number | null;
    parentNode?: string;
    zIndex?: number;
    extent?: 'parent' | [number, number, number, number];
    expandParent?: boolean;
  }

  export interface Edge<T = unknown> {
    id: string;
    type?: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
    label?: string | ReactNode;
    labelStyle?: CSSProperties;
    labelShowBg?: boolean;
    labelBgStyle?: CSSProperties;
    labelBgPadding?: [number, number];
    labelBgBorderRadius?: number;
    style?: CSSProperties;
    animated?: boolean;
    hidden?: boolean;
    data?: T;
    className?: string;
    sourceNode?: Node;
    targetNode?: Node;
    selected?: boolean;
    markerEnd?: string;
    markerStart?: string;
    zIndex?: number;
    interactionWidth?: number;
    updatable?: boolean;
  }

  export interface Connection {
    source: string | null;
    target: string | null;
    sourceHandle: string | null;
    targetHandle: string | null;
  }

  export enum ConnectionLineType {
    Bezier = 'default',
    Straight = 'straight',
    Step = 'step',
    SmoothStep = 'smoothstep',
    SimpleBezier = 'simplebezier',
  }

  export interface HandleProps {
    type: 'source' | 'target';
    position: Position;
    isConnectable?: boolean;
    onConnect?: (connection: Connection) => void;
    isValidConnection?: (connection: Connection) => boolean;
    id?: string;
    style?: CSSProperties;
    className?: string;
  }

  export function Handle(props: HandleProps): JSX.Element;

  export function useNodesState(
    initialNodes: Node[],
  ): [
    Node[],
    React.Dispatch<React.SetStateAction<Node[]>>,
    (changes: unknown) => void,
  ];

  export function useEdgesState(
    initialEdges: Edge[],
  ): [
    Edge[],
    React.Dispatch<React.SetStateAction<Edge[]>>,
    (changes: unknown) => void,
  ];

  export function addEdge(edgeParams: Edge | Connection, edges: Edge[]): Edge[];

  export interface ReactFlowProps {
    nodes: Node[];
    edges: Edge[];
    defaultNodes?: Node[];
    defaultEdges?: Edge[];
    onNodesChange?: (changes: unknown) => void;
    onEdgesChange?: (changes: unknown) => void;
    onConnect?: (connection: Connection) => void;
    onNodeClick?: (event: MouseEvent, node: Node) => void;
    onNodeDoubleClick?: (event: MouseEvent, node: Node) => void;
    onNodeMouseEnter?: (event: MouseEvent, node: Node) => void;
    onNodeMouseMove?: (event: MouseEvent, node: Node) => void;
    onNodeMouseLeave?: (event: MouseEvent, node: Node) => void;
    onNodeContextMenu?: (event: MouseEvent, node: Node) => void;
    onNodeDragStart?: (event: MouseEvent, node: Node) => void;
    onNodeDrag?: (event: MouseEvent, node: Node) => void;
    onNodeDragStop?: (event: MouseEvent, node: Node) => void;
    onEdgeClick?: (event: MouseEvent, edge: Edge) => void;
    onEdgeDoubleClick?: (event: MouseEvent, edge: Edge) => void;
    onEdgeMouseEnter?: (event: MouseEvent, edge: Edge) => void;
    onEdgeMouseMove?: (event: MouseEvent, edge: Edge) => void;
    onEdgeMouseLeave?: (event: MouseEvent, edge: Edge) => void;
    onEdgeContextMenu?: (event: MouseEvent, edge: Edge) => void;
    onEdgeUpdate?: (oldEdge: Edge, newConnection: Connection) => void;
    onEdgeUpdateStart?: (event: MouseEvent, edge: Edge) => void;
    onEdgeUpdateEnd?: (event: MouseEvent, edge: Edge) => void;
    nodeTypes?: NodeTypes;
    edgeTypes?: unknown;
    connectionLineType?: ConnectionLineType;
    connectionLineStyle?: CSSProperties;
    connectionLineComponent?: unknown;
    connectionMode?: unknown;
    deleteKeyCode?: string | null;
    selectionKeyCode?: string | null;
    multiSelectionKeyCode?: string | null;
    zoomActivationKeyCode?: string | null;
    snapToGrid?: boolean;
    snapGrid?: [number, number];
    onlyRenderVisibleElements?: boolean;
    nodesDraggable?: boolean;
    nodesConnectable?: boolean;
    elementsSelectable?: boolean;
    selectNodesOnDrag?: boolean;
    panOnDrag?: boolean;
    minZoom?: number;
    maxZoom?: number;
    defaultZoom?: number;
    defaultPosition?: [number, number];
    translateExtent?: [[number, number], [number, number]];
    preventScrolling?: boolean;
    nodeExtent?: [[number, number], [number, number]];
    defaultMarkerColor?: string;
    zoomOnScroll?: boolean;
    zoomOnPinch?: boolean;
    panOnScroll?: boolean;
    panOnScrollSpeed?: number;
    panOnScrollMode?: unknown;
    zoomOnDoubleClick?: boolean;
    fitView?: boolean;
    fitViewOptions?: unknown;
    connectOnClick?: boolean;
    attributionPosition?: unknown;
    proOptions?: unknown;
    children?: ReactNode;
  }

  export function Background(props?: unknown): JSX.Element;
  export function Controls(props?: unknown): JSX.Element;
  export function MiniMap(props?: unknown): JSX.Element;

  export default function ReactFlow(props: ReactFlowProps): JSX.Element;
}
