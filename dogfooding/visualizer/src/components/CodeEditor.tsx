import React from 'react';
import Editor from '@monaco-editor/react';

interface CodeEditorProps {
  code?: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}

const CodeEditor: React.FC<CodeEditorProps> = ({
  code = '',
  onChange,
  readOnly = false,
}) => {
  const handleEditorChange = (value: string | undefined) => {
    if (onChange && value !== undefined && !readOnly) {
      onChange(value);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 bg-gray-100 border-b font-medium">
        Template Code{readOnly ? ' (Read-only)' : ''}
      </div>
      <div className="flex-1">
        <Editor
          height="100%"
          defaultLanguage="typescript"
          value={code}
          onChange={handleEditorChange}
          options={{
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 14,
            tabSize: 2,
            readOnly: readOnly,
          }}
        />
      </div>
    </div>
  );
};

export default CodeEditor;
