import React, { useState, KeyboardEvent, FC } from 'react';
import { useTemplateStore } from '../../utils/templateStore';

interface SubroutineTemplateContentProps {
  templateId: string;
  initWith: string;
  squashWith?: string;
  name?: string;
  nodeId?: string;
}

/**
 * Component to display Subroutine template content with in-place editing
 */
const SubroutineTemplateContent: FC<SubroutineTemplateContentProps> = ({
  templateId,
  initWith,
  squashWith,
  name = 'Subroutine Template',
  nodeId,
}) => {
  const { updateTemplate } = useTemplateStore();

  // State for editing fields
  const [editingField, setEditingField] = useState<
    'name' | 'templateId' | 'initWith' | 'squashWith' | null
  >(null);
  const [editedName, setEditedName] = useState(name);
  const [editedTemplateId, setEditedTemplateId] = useState(templateId || '');
  const [editedInitWith, setEditedInitWith] = useState(initWith || '');
  const [editedSquashWith, setEditedSquashWith] = useState(squashWith || '');

  const handleClick = (
    field: 'name' | 'templateId' | 'initWith' | 'squashWith',
  ) => {
    if (field === 'name') {
      setEditedName(name);
    } else if (field === 'templateId') {
      setEditedTemplateId(templateId || '');
    } else if (field === 'initWith') {
      setEditedInitWith(initWith || '');
    } else {
      setEditedSquashWith(squashWith || '');
    }
    setEditingField(field);
  };

  const handleBlur = () => {
    if (nodeId && editingField) {
      const updates: Record<string, string | undefined> = {};

      if (editingField === 'name' && editedName !== name) {
        updates.name = editedName;
      } else if (
        editingField === 'templateId' &&
        editedTemplateId !== templateId
      ) {
        updates.templateId = editedTemplateId;
      } else if (editingField === 'initWith' && editedInitWith !== initWith) {
        updates.initWith = editedInitWith;
      } else if (
        editingField === 'squashWith' &&
        editedSquashWith !== squashWith
      ) {
        updates.squashWith = editedSquashWith || undefined;
      }

      if (Object.keys(updates).length > 0) {
        updateTemplate(nodeId, { data: updates });
      }
    }
    setEditingField(null);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleBlur();
    } else if (e.key === 'Escape') {
      setEditedName(name);
      setEditedTemplateId(templateId || '');
      setEditedInitWith(initWith || '');
      setEditedSquashWith(squashWith || '');
      setEditingField(null);
    }
  };

  return (
    <div className="subroutine-template-content">
      <div className="text-xs text-gray-500 mb-1">Name:</div>
      {editingField === 'name' ? (
        <input
          type="text"
          className="text-sm p-2 bg-white rounded border border-red-500 w-full focus:outline-none focus:ring-2 focus:ring-red-300 mb-2"
          value={editedName}
          onChange={(e) => setEditedName(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          placeholder="Enter template name..."
        />
      ) : (
        <div
          className="text-sm p-2 bg-white rounded border border-red-200 mb-2 cursor-pointer hover:border-red-500"
          onClick={() => handleClick('name')}
        >
          {name || (
            <span className="italic text-gray-400">Click to add name</span>
          )}
        </div>
      )}

      <div className="text-xs text-gray-500 mb-1">Template ID:</div>
      {editingField === 'templateId' ? (
        <input
          type="text"
          className="text-sm p-2 bg-white rounded border border-red-500 w-full focus:outline-none focus:ring-2 focus:ring-red-300 mb-2"
          value={editedTemplateId}
          onChange={(e) => setEditedTemplateId(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          placeholder="Enter template ID..."
        />
      ) : (
        <div
          className="text-sm p-2 bg-white rounded border border-red-200 mb-2 cursor-pointer hover:border-red-500"
          onClick={() => handleClick('templateId')}
        >
          {templateId || (
            <span className="italic text-gray-400">
              Click to specify template ID
            </span>
          )}
        </div>
      )}

      <div className="text-xs text-gray-500 mb-1">Init With:</div>
      {editingField === 'initWith' ? (
        <textarea
          className="text-sm p-2 bg-white rounded border border-red-500 w-full font-mono text-xs focus:outline-none focus:ring-2 focus:ring-red-300 mb-2"
          value={editedInitWith}
          onChange={(e) => setEditedInitWith(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          rows={3}
          placeholder="Enter init function..."
        />
      ) : (
        <div
          className="text-sm p-2 bg-white rounded border border-red-200 font-mono text-xs mb-2 cursor-pointer hover:border-red-500"
          onClick={() => handleClick('initWith')}
        >
          {initWith || (
            <span className="italic text-gray-400">
              Click to add init function
            </span>
          )}
        </div>
      )}

      <div className="text-xs text-gray-500 mb-1">Squash With (optional):</div>
      {editingField === 'squashWith' ? (
        <textarea
          className="text-sm p-2 bg-white rounded border border-red-500 w-full font-mono text-xs focus:outline-none focus:ring-2 focus:ring-red-300"
          value={editedSquashWith}
          onChange={(e) => setEditedSquashWith(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          autoFocus
          rows={3}
          placeholder="Enter squash function..."
        />
      ) : (
        <div
          className="text-sm p-2 bg-white rounded border border-red-200 font-mono text-xs cursor-pointer hover:border-red-500"
          onClick={() => handleClick('squashWith')}
        >
          {squashWith || (
            <span className="italic text-gray-400">
              Click to add squash function (optional)
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export default SubroutineTemplateContent;
