import React, { useEffect, useState, useRef } from 'react';
import { useTemplateStore } from '../utils/templateStore';
import MonacoEditor, { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

/**
 * Component to display the generated code
 */
const TemplateCodePanel: React.FC = () => {
  const { generateCode, templates } = useTemplateStore();
  const [code, setCode] = useState<string>('');
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // Handle editor mount
  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  // Generate code from current state
  useEffect(() => {
    const generatedCode = generateCode();
    setCode(generatedCode);
  }, [generateCode, templates]);

  return (
    <div className="template-code-panel h-full flex flex-col">
      <div className="code-editor flex-grow">
        <MonacoEditor
          height="100%"
          language="typescript"
          theme="vs-light"
          value={code}
          onMount={handleEditorDidMount}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: true,
            fontSize: 14,
            automaticLayout: true,
            wordWrap: 'on',
          }}
        />
      </div>
    </div>
  );
};

export default TemplateCodePanel;
