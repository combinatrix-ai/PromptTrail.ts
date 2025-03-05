import { memo, ReactNode, FC } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';

interface CompositeNodeProps extends NodeProps {
  data: {
    label: string;
    children: ReactNode;
    expanded?: boolean;
    onToggleExpand?: () => void;
    onAddChild?: () => void;
    [key: string]: unknown;
  };
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
}

const CompositeNode: FC<CompositeNodeProps> = memo(
  ({
    data,
    className = 'composite-node',
    headerClassName = 'composite-node-header',
    contentClassName = 'composite-node-content',
    ...props
  }) => {
    const {
      label,
      children,
      expanded = true,
      onToggleExpand,
      onAddChild,
    } = data;

    return (
      <div className={`${className}`}>
        <Handle type="target" position={Position.Top} />

        <div className={headerClassName}>
          <span>{label || 'Container'}</span>
          <div className="flex gap-2">
            {onAddChild && (
              <button
                onClick={onAddChild}
                className="add-child-btn"
                title="Add Child Node"
                type="button"
              >
                + Add
              </button>
            )}
            <button
              onClick={onToggleExpand}
              className="expand-toggle"
              type="button"
            >
              {expanded ? '▼' : '►'}
            </button>
          </div>
        </div>

        {expanded && <div className={contentClassName}>{children}</div>}

        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  },
);

export default CompositeNode;
