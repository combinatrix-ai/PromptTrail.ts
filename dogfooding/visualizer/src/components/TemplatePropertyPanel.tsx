import { useState, useEffect, FormEvent, FC } from 'react';
import { useTemplateStore } from '../utils/templateStore';

/**
 * Component to edit template properties
 */
const TemplatePropertyPanel: FC = () => {
  const { templates, selectedId, updateTemplate } = useTemplateStore();
  const [formData, setFormData] = useState<
    Record<string, string | number | boolean>
  >({});

  // Find the selected template
  const selectedTemplate = selectedId
    ? templates.find((t) => t.id === selectedId)
    : null;

  // Update form data when selection changes
  useEffect(() => {
    if (selectedTemplate) {
      setFormData({
        ...(selectedTemplate.data as Record<string, string | number | boolean>),
      });
    } else {
      setFormData({});
    }
  }, [selectedTemplate]);

  // No template selected
  if (!selectedTemplate) {
    return (
      <div className="template-property-panel p-4 bg-white rounded-lg shadow">
        <h2 className="text-lg font-bold mb-4">Properties</h2>
        <p className="text-gray-500 italic">
          Select a template to edit its properties
        </p>
      </div>
    );
  }

  // Handle input changes
  const handleInputChange = (key: string, value: string) => {
    setFormData((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  // Handle form submission
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    updateTemplate(selectedTemplate.id, { data: formData });
  };

  // Render form fields based on template type
  const renderFields = () => {
    switch (selectedTemplate.type) {
      case 'System':
        return (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Content
              </label>
              <textarea
                className="w-full p-2 border border-gray-300 rounded"
                rows={5}
                value={(formData.content as string) || ''}
                onChange={(e) => handleInputChange('content', e.target.value)}
              />
            </div>
          </>
        );

      case 'User':
        return (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <input
                type="text"
                className="w-full p-2 border border-gray-300 rounded"
                value={(formData.description as string) || ''}
                onChange={(e) =>
                  handleInputChange('description', e.target.value)
                }
              />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Default Value
              </label>
              <input
                type="text"
                className="w-full p-2 border border-gray-300 rounded"
                value={(formData.default as string) || ''}
                onChange={(e) => handleInputChange('default', e.target.value)}
              />
            </div>
          </>
        );

      case 'Assistant':
        return (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Assistant Type
              </label>
              <select
                className="w-full p-2 border border-gray-300 rounded"
                value={(formData.assistantType as string) || 'model'}
                onChange={(e) =>
                  handleInputChange('assistantType', e.target.value)
                }
              >
                <option value="model">Use LLM to generate content</option>
                <option value="content">
                  Provide fixed content (impersonate LLM)
                </option>
              </select>
            </div>

            {formData.assistantType !== 'content' && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Model
                </label>
                <input
                  type="text"
                  className="w-full p-2 border border-gray-300 rounded"
                  value={(formData.model as string) || ''}
                  onChange={(e) => handleInputChange('model', e.target.value)}
                />
              </div>
            )}

            {formData.assistantType !== 'model' && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Content
                </label>
                <textarea
                  className="w-full p-2 border border-gray-300 rounded"
                  rows={5}
                  value={(formData.content as string) || ''}
                  onChange={(e) => handleInputChange('content', e.target.value)}
                />
              </div>
            )}
          </>
        );

      case 'Loop':
        return (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Exit Condition
              </label>
              <textarea
                className="w-full p-2 border border-gray-300 rounded font-mono text-sm"
                rows={8}
                value={
                  (formData.exitCondition as string) || '(session) => false'
                }
                onChange={(e) =>
                  handleInputChange('exitCondition', e.target.value)
                }
              />
              <p className="text-xs text-gray-500 mt-1">
                Function that returns true when the loop should exit
              </p>
            </div>
          </>
        );

      case 'Subroutine':
        return (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Template ID
              </label>
              <input
                type="text"
                className="w-full p-2 border border-gray-300 rounded"
                value={(formData.templateId as string) || ''}
                onChange={(e) =>
                  handleInputChange('templateId', e.target.value)
                }
              />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Init With
              </label>
              <textarea
                className="w-full p-2 border border-gray-300 rounded font-mono text-sm"
                rows={5}
                value={(formData.initWith as string) || '(session) => ({})'}
                onChange={(e) => handleInputChange('initWith', e.target.value)}
              />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Squash With (Optional)
              </label>
              <textarea
                className="w-full p-2 border border-gray-300 rounded font-mono text-sm"
                rows={5}
                value={(formData.squashWith as string) || ''}
                onChange={(e) =>
                  handleInputChange('squashWith', e.target.value)
                }
              />
            </div>
          </>
        );

      default:
        return (
          <p className="text-gray-500">
            No editable properties for this template type
          </p>
        );
    }
  };

  return (
    <div className="template-property-panel p-4 bg-white rounded-lg shadow">
      <h2 className="text-lg font-bold mb-1">Properties</h2>
      <p className="text-sm text-gray-500 mb-4">
        {selectedTemplate.type} Template
      </p>

      <form onSubmit={handleSubmit}>
        {renderFields()}

        <div className="flex justify-end">
          <button
            type="submit"
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Apply Changes
          </button>
        </div>
      </form>
    </div>
  );
};

export default TemplatePropertyPanel;
