import React from 'react';
import TemplateToolbar from './TemplateToolbar';
import TemplateContainer from './TemplateContainer';
import TemplateCodePanel from './TemplateCodePanel';

/**
 * Main application component
 *
 * The property panel has been removed as all template properties
 * can now be edited directly in-place within the template nodes.
 */
const App: React.FC = () => {
  return (
    <div className="app-container h-screen flex flex-col">
      <TemplateToolbar />

      <div className="main-content flex-grow flex overflow-hidden">
        {/* Left panel: Template visualization */}
        <div className="template-view-panel w-1/2 overflow-auto p-2 bg-gray-50 border-r">
          <TemplateContainer />
        </div>

        <div className="right-panel w-1/2 flex flex-col">
          {/* Code panel (now takes full height) */}
          <div className="code-panel h-full overflow-hidden">
            <TemplateCodePanel />
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
