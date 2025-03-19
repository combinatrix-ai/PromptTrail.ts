import React, { FC } from 'react';

interface ToolbarProps {
  onReset?: () => void;
}

const Toolbar: FC<ToolbarProps> = ({ onReset }) => {
  return (
    <div className="toolbar">
      <h1 className="text-xl font-bold">PromptTrail Template Visualizer</h1>

      <div className="flex-1"></div>

      <div className="flex items-center space-x-2">
        <button className="btn btn-secondary" onClick={onReset}>
          Reset
        </button>
      </div>
    </div>
  );
};

export default Toolbar;
