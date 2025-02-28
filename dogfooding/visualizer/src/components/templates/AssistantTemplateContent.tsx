import React, { useState } from 'react';
import { useTemplateStore } from '../../utils/templateStore';

interface AssistantTemplateContentProps {
  assistantType?: 'model' | 'content';
  model?: string;
  content?: string;
  nodeId?: string;
}

/**
 * Component to display Assistant template content with in-place editing
 */
const AssistantTemplateContent: React.FC<AssistantTemplateContentProps> = ({
  assistantType = 'model',
  model,
  content,
  nodeId,
}) => {
  const { updateTemplate, templates } = useTemplateStore();

  // Get the current assistantType from the store to ensure it's up-to-date
  const currentNode = nodeId ? templates.find((t) => t.id === nodeId) : null;
  const currentAssistantType =
    currentNode?.data?.assistantType || assistantType;

  const [editingField, setEditingField] = useState<'model' | 'content' | null>(
    null,
  );
  const [editedModel, setEditedModel] = useState(model || '');
  const [editedContent, setEditedContent] = useState(content || '');

  const handleClick = (field: 'model' | 'content') => {
    if (field === 'model') {
      setEditedModel(model || '');
    } else {
      setEditedContent(content || '');
    }
    setEditingField(field);
  };

  const handleBlur = () => {
    if (nodeId && editingField) {
      const updates: any = {};

      if (editingField === 'model' && editedModel !== model) {
        updates.model = editedModel || undefined;
      } else if (editingField === 'content' && editedContent !== content) {
        updates.content = editedContent || undefined;
      }

      if (Object.keys(updates).length > 0) {
        updateTemplate(nodeId, { data: updates });
      }
    }
    setEditingField(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleBlur();
    } else if (e.key === 'Escape') {
      setEditedModel(model || '');
      setEditedContent(content || '');
      setEditingField(null);
    }
  };

  return (
    <div className="assistant-template-content">
      <div className="text-xs text-gray-500 mb-1">Type:</div>
      <div className="mb-3 flex flex-col space-y-2">
        <label className="flex items-center">
          <input
            type="radio"
            name={`assistant-type-${nodeId}`}
            value="model"
            checked={currentAssistantType === 'model'}
            onChange={() => {
              if (nodeId) {
                updateTemplate(nodeId, {
                  data: {
                    assistantType: 'model',
                  },
                });
              }
            }}
            className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300"
          />
          <span className="ml-2 text-sm text-gray-700">
            Use LLM to generate content
          </span>
        </label>
        <label className="flex items-center">
          <input
            type="radio"
            name={`assistant-type-${nodeId}`}
            value="content"
            checked={currentAssistantType === 'content'}
            onChange={() => {
              if (nodeId) {
                updateTemplate(nodeId, {
                  data: {
                    assistantType: 'content',
                  },
                });
              }
            }}
            className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300"
          />
          <span className="ml-2 text-sm text-gray-700">
            Fixed content (impersonating LLM)
          </span>
        </label>
      </div>

      {currentAssistantType === 'model' && (
        <>
          <div className="text-xs text-gray-500 mb-1">Model:</div>
          {editingField === 'model' ? (
            <input
              type="text"
              className="text-sm p-2 bg-white rounded border border-purple-500 w-full focus:outline-none focus:ring-2 focus:ring-purple-300 mb-2"
              value={editedModel}
              onChange={(e) => setEditedModel(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              autoFocus
              placeholder="Enter model name (e.g., gpt-4o-mini)"
            />
          ) : (
            <div
              className="text-sm p-2 bg-white rounded border border-purple-200 mb-2 cursor-pointer hover:border-purple-500"
              onClick={() => handleClick('model')}
            >
              {model || (
                <span className="italic text-gray-400">
                  Click to specify model
                </span>
              )}
            </div>
          )}
        </>
      )}

      {currentAssistantType === 'content' && (
        <>
          <div className="text-xs text-gray-500 mb-1">Content:</div>
          {editingField === 'content' ? (
            <textarea
              className="text-sm p-2 bg-white rounded border border-purple-500 w-full focus:outline-none focus:ring-2 focus:ring-purple-300"
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              autoFocus
              rows={3}
              placeholder="Enter fixed content..."
            />
          ) : (
            <div
              className="text-sm p-2 bg-white rounded border border-purple-200 cursor-pointer hover:border-purple-500"
              onClick={() => handleClick('content')}
            >
              {content || (
                <span className="italic text-gray-400">
                  Click to add content
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default AssistantTemplateContent;
