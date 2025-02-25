import React, { useState } from 'react';
import { useTemplateStore } from '../../utils/templateStore';

interface LoopTemplateContentProps {
  exitCondition: string;
  name?: string;
  nodeId?: string;
}

/**
 * Component to display Loop template content with in-place editing
 */
const LoopTemplateContent: React.FC<LoopTemplateContentProps> = ({
  exitCondition,
  name = 'Loop Template',
  nodeId,
}) => {
  const { updateTemplate } = useTemplateStore();

  // States for editing fields
  const [editingField, setEditingField] = useState<
    'name' | 'exitCondition' | null
  >(null);
  const [editedName, setEditedName] = useState(name);
  const [editedExitCondition, setEditedExitCondition] = useState(
    exitCondition || '',
  );

  const handleNameDoubleClick = () => {
    setEditedName(name);
    setEditingField('name');
  };

  const handleExitConditionDoubleClick = () => {
    setEditedExitCondition(exitCondition || '');
    setEditingField('exitCondition');
  };

  const handleBlur = () => {
    if (nodeId && editingField) {
      if (editingField === 'name' && editedName !== name) {
        updateTemplate(nodeId, { data: { name: editedName } });
      } else if (
        editingField === 'exitCondition' &&
        editedExitCondition !== exitCondition
      ) {
        updateTemplate(nodeId, {
          data: { exitCondition: editedExitCondition },
        });
      }
    }
    setEditingField(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleBlur();
    } else if (e.key === 'Escape') {
      setEditedName(name);
      setEditedExitCondition(exitCondition || '');
      setEditingField(null);
    }
  };

  return (
    <div className="loop-template-content">
      <div className="text-xs text-gray-500 mb-1">Name:</div>
      {editingField === 'name' ? (
        <input
          type="text"
          className="text-sm p-2 bg-white rounded border border-yellow-500 w-full focus:outline-none focus:ring-2 focus:ring-yellow-300 mb-2"
          value={editedName}
          onChange={(e) => setEditedName(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          placeholder="Enter template name..."
        />
      ) : (
        <div
          className="text-sm p-2 bg-white rounded border border-yellow-200 cursor-pointer hover:border-yellow-500 mb-2"
          onClick={handleNameDoubleClick}
        >
          {name || (
            <span className="italic text-gray-400">Click to add name</span>
          )}
        </div>
      )}

      <div className="text-xs text-gray-500 mb-1">Exit Condition:</div>
      {editingField === 'exitCondition' ? (
        <textarea
          className="text-sm p-2 bg-white rounded border border-yellow-500 w-full font-mono text-xs focus:outline-none focus:ring-2 focus:ring-yellow-300"
          value={editedExitCondition}
          onChange={(e) => setEditedExitCondition(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          rows={4}
          placeholder="Enter exit condition function..."
        />
      ) : (
        <div
          className="text-sm p-2 bg-white rounded border border-yellow-200 font-mono text-xs cursor-pointer hover:border-yellow-500"
          onClick={handleExitConditionDoubleClick}
        >
          {exitCondition || (
            <span className="italic text-gray-400">
              Click to add exit condition
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default LoopTemplateContent;
