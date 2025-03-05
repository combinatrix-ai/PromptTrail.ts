import { FC } from 'react';
import { useTemplateStore } from '../utils/templateStore';

/**
 * Toolbar component for the template visualizer
 */
const TemplateToolbar: FC = () => {
  const { resetStore } = useTemplateStore();

  const handleReset = () => {
    if (confirm('Reset all templates? This cannot be undone.')) {
      resetStore();
    }
  };

  return (
    <div className="template-toolbar p-2 bg-gray-100 border-b flex items-center space-x-2">
      <h1 className="text-xl font-bold mr-auto">
        PromptTrail Template Visual Builder
      </h1>

      <div className="flex space-x-2">
        <button
          className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm"
          onClick={handleReset}
          title="Reset to default template"
        >
          Reset
        </button>
      </div>
    </div>
  );
};

export default TemplateToolbar;
