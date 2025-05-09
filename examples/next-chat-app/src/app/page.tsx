'use client';

import { Message, useChat } from 'ai/react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { get_encoding } from 'tiktoken';

// Import our custom CSS
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  RefreshCw,
} from 'lucide-react';
import './chat-ui-styles.css';

interface DirectoryItem {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: DirectoryItem[];
  isExpanded?: boolean;
  isLoadingChildren?: boolean;
  level: number; // To manage indentation
}

// ChatInterface component
interface ChatInterfaceProps {
  initialCodeContext: string;
  messages: Message[];
  input: string;
  handleInputChange: (
    e:
      | React.ChangeEvent<HTMLTextAreaElement>
      | React.ChangeEvent<HTMLInputElement>,
  ) => void;
  handleSubmit: (e: FormEvent<HTMLFormElement>) => void;
  isLoading: boolean;
  error: Error | undefined;
  tokenCount: number; // Added tokenCount prop
}

function ChatInterface({
  initialCodeContext,
  messages,
  input,
  handleInputChange,
  handleSubmit,
  isLoading,
  error,
  tokenCount, // Destructure tokenCount
}: ChatInterfaceProps) {
  return (
    <div className="flex flex-col h-full">
      {' '}
      {/* Ensure ChatInterface takes full height of its tab panel */}
      <div className="mb-4 p-4 border rounded bg-gray-50 dark:bg-gray-800">
        <div className="flex justify-between items-center mb-1">
          <h2 className="text-sm font-semibold">Current Chat Context:</h2>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            Tokens: {tokenCount}
          </p>
        </div>
        <div className="max-h-32 overflow-y-auto">
          {' '}
          {/* Made context scrollable within a fixed height */}
          {initialCodeContext ? (
            <pre className="text-xs whitespace-pre-wrap break-words">
              <code>{initialCodeContext}</code>
            </pre>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              No context loaded. Use the Context Editor tab to load files.
            </p>
          )}
        </div>
      </div>
      {error && (
        <div
          className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4"
          role="alert"
        >
          <strong className="font-bold">Error:</strong>
          <span className="block sm:inline"> {error.message}</span>
        </div>
      )}
      <div className="flex-1 overflow-hidden rounded-md bg-background shadow-lg">
        <div className="h-[calc(100%-theme(space.16))] flex flex-col">
          {' '}
          {/* Adjust height based on input area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'} mb-4`}
              >
                <div
                  className={
                    message.role === 'user'
                      ? 'bg-primary text-primary-foreground rounded-lg p-3 max-w-[80%]'
                      : 'bg-card text-card-foreground p-3 max-w-[85%]'
                  }
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      div: (props) => (
                        <div
                          className="prose prose-sm dark:prose-invert max-w-none"
                          {...props}
                        />
                      ),
                      pre: (props) => (
                        <pre
                          className="bg-gray-800 text-gray-100 overflow-x-auto rounded-md p-3 text-sm"
                          {...props}
                        />
                      ),
                      code: ({ className, children, ...props }) => {
                        const match = /language-(\w+)/.exec(className || '');
                        return match ? (
                          <code className={className} {...props}>
                            {children}
                          </code>
                        ) : (
                          <code
                            className="bg-gray-700 px-1 py-0.5 rounded text-gray-100"
                            {...props}
                          >
                            {children}
                          </code>
                        );
                      },
                      p: (props) => <p className="my-1" {...props} />,
                      ul: (props) => (
                        <ul className="list-disc pl-5 my-2" {...props} />
                      ),
                      ol: (props) => (
                        <ol className="list-decimal pl-5 my-2" {...props} />
                      ),
                      li: (props) => <li className="my-1" {...props} />,
                      a: (props) => (
                        <a className="text-blue-200 underline" {...props} />
                      ),
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-border p-4 bg-muted/50 dark:bg-muted/20">
            <form
              onSubmit={handleSubmit}
              className="flex gap-2 items-center bg-background p-3 rounded-lg shadow-sm"
            >
              <textarea
                className="flex-1 min-h-10 max-h-40 p-2 rounded-md border border-input focus:outline-none focus:ring-2 focus:ring-ring bg-transparent dark:text-foreground resize-none"
                value={input}
                placeholder={
                  isLoading ? 'Thinking...' : 'Ask about the code...'
                }
                onChange={handleInputChange}
                disabled={isLoading}
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!isLoading && input.trim()) {
                      const form = e.currentTarget.closest('form');
                      if (form) {
                        form.dispatchEvent(
                          new Event('submit', {
                            cancelable: true,
                            bubbles: true,
                          }),
                        );
                      }
                    }
                  }
                  const textarea = e.currentTarget;
                  textarea.style.height = 'auto';
                  textarea.style.height = `${textarea.scrollHeight}px`;
                }}
                style={{ maxHeight: '150px', overflowY: 'auto' }}
              />
              <button
                type="submit"
                className="p-2 rounded-md bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 flex items-center justify-center"
                disabled={isLoading || !input.trim()}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="w-5 h-5"
                >
                  <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
                </svg>
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

// ContextEditor component
function ContextEditor({
  onUpdateCodeContext,
}: {
  onUpdateCodeContext: (newContext: string) => void;
}) {
  const [dirPath, setDirPath] = useState<string>('.');
  const [directoryStructure, setDirectoryStructure] = useState<DirectoryItem[]>(
    [],
  );
  const [isLoadingDirectory, setIsLoadingDirectory] = useState<boolean>(false);
  const [errorLoadingDirectory, setErrorLoadingDirectory] = useState<
    string | null
  >(null);
  // selectedPaths stores:
  // - boolean for files (true if selected, false/undefined otherwise)
  // - 'SELECTED' | 'UNSELECTED' for directories
  const [selectedPaths, setSelectedPaths] = useState<
    Record<string, boolean | 'SELECTED' | 'UNSELECTED'>
  >({});
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);
  const [newExtensionInput, setNewExtensionInput] = useState<string>('');

  const addExtension = () => {
    const trimmedExt = newExtensionInput.trim();
    // Basic validation: ensure it starts with a dot and isn't already added
    if (
      trimmedExt &&
      trimmedExt.startsWith('.') &&
      !selectedExtensions.includes(trimmedExt)
    ) {
      setSelectedExtensions((prev) => [...prev, trimmedExt]);
      setNewExtensionInput(''); // Clear input after adding
    } else if (!trimmedExt.startsWith('.')) {
      alert('Extension must start with a dot (e.g., .ts)');
    } else if (selectedExtensions.includes(trimmedExt)) {
      alert('Extension already added.');
    }
  };

  const removeExtension = (extensionToRemove: string) => {
    setSelectedExtensions((prev) =>
      prev.filter((ext) => ext !== extensionToRemove),
    );
  };

  const handleLoadDirectory = async () => {
    setIsLoadingDirectory(true);
    setErrorLoadingDirectory(null);
    try {
      const response = await fetch('/api/list-directory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error || `Failed to load directory: ${response.statusText}`,
        );
      }
      const data = await response.json();
      // Initialize level and isExpanded for top-level items
      const initialStructure = (data.contents || []).map(
        (item: Omit<DirectoryItem, 'level'>) => ({
          ...item,
          level: 0,
          isExpanded: false,
          children: item.type === 'directory' ? [] : undefined, // Initialize children for directories
        }),
      );
      setDirectoryStructure(initialStructure);
      // setSelectedPaths({}); // Removed: Do not reset selected paths when new directory is loaded
    } catch (err: unknown) {
      if (err instanceof Error) {
        setErrorLoadingDirectory(err.message);
      } else {
        setErrorLoadingDirectory(
          'An unknown error occurred while loading directory.',
        );
      }
      // setDirectoryStructure([]); // Removed: Do not clear structure on error if one already exists
    } finally {
      setIsLoadingDirectory(false);
    }
  };

  // Recursive helper to update the directory structure immutably
  const updateDirectoryStructureRecursively = (
    items: DirectoryItem[],
    targetPath: string,
    updateFn: (item: DirectoryItem) => DirectoryItem,
  ): DirectoryItem[] => {
    return items.map((item) => {
      if (item.path === targetPath) {
        return updateFn(item);
      }
      if (item.children) {
        const updatedChildren = updateDirectoryStructureRecursively(
          item.children,
          targetPath,
          updateFn,
        );
        // If children were updated, create a new item object
        if (updatedChildren !== item.children) {
          return { ...item, children: updatedChildren };
        }
      }
      return item;
    });
  };

  const toggleExpandAndLoadChildren = async (itemPath: string) => {
    // Find the item in the current structure first
    const itemToToggle = findItemByPath(directoryStructure, itemPath);

    if (!itemToToggle || itemToToggle.type !== 'directory') return;

    const isCurrentlyExpanded = !!itemToToggle.isExpanded;
    const isNowExpanding = !isCurrentlyExpanded;
    const needsLoading =
      isNowExpanding &&
      (!itemToToggle.children || itemToToggle.children.length === 0);

    // Update the expanded/loading state immediately
    setDirectoryStructure((prevStructure) =>
      updateDirectoryStructureRecursively(prevStructure, itemPath, (item) => ({
        ...item,
        isExpanded: isNowExpanding,
        isLoadingChildren: needsLoading,
      })),
    );

    // If it needs loading, perform the fetch
    if (needsLoading) {
      try {
        const response = await fetch('/api/list-directory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: itemPath }),
        });
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(
            errorData.error ||
              `Failed to load directory: ${response.statusText}`,
          );
        }
        const data = await response.json();

        const rawChildrenItems = (data.contents || []).map(
          (
            child: Omit<
              DirectoryItem,
              'level' | 'isExpanded' | 'isLoadingChildren'
            >,
          ) => ({
            ...child,
            level: itemToToggle.level + 1,
            isExpanded: false,
            isLoadingChildren: false,
            children: child.type === 'directory' ? [] : undefined,
          }),
        );

        // Propagate selection state to newly loaded children
        const parentSelectionState = selectedPaths[itemPath];
        const newSelectedPathsUpdate = { ...selectedPaths };
        let selectionsChanged = false;

        if (
          parentSelectionState === 'SELECTED' ||
          parentSelectionState === 'UNSELECTED'
        ) {
          const shouldSelectChildren = parentSelectionState === 'SELECTED';
          rawChildrenItems.forEach((loadedChild: DirectoryItem) => {
            // Added type for loadedChild
            if (loadedChild.type === 'file') {
              if (
                newSelectedPathsUpdate[loadedChild.path] !==
                shouldSelectChildren
              ) {
                newSelectedPathsUpdate[loadedChild.path] = shouldSelectChildren;
                selectionsChanged = true;
              }
            } else {
              // Directory
              const targetState = shouldSelectChildren
                ? 'SELECTED'
                : 'UNSELECTED';
              if (newSelectedPathsUpdate[loadedChild.path] !== targetState) {
                newSelectedPathsUpdate[loadedChild.path] = targetState;
                selectionsChanged = true;
              }
            }
          });
        }
        if (selectionsChanged) {
          setSelectedPaths(newSelectedPathsUpdate);
        }

        setDirectoryStructure((prevStructure) =>
          updateDirectoryStructureRecursively(
            prevStructure,
            itemPath,
            (item) => ({
              ...item,
              children: rawChildrenItems,
              isLoadingChildren: false,
            }),
          ),
        );
      } catch (err: unknown) {
        console.error(`Error loading children for ${itemPath}:`, err);
        setDirectoryStructure((prevStructure) =>
          updateDirectoryStructureRecursively(
            prevStructure,
            itemPath,
            (item) => ({
              ...item,
              isLoadingChildren: false,
              // Optionally add an error state to the item here
            }),
          ),
        );
      }
    }
  };

  // Find item by path recursively
  const findItemByPath = (
    items: DirectoryItem[],
    path: string,
  ): DirectoryItem | null => {
    for (const item of items) {
      if (item.path === path) return item;
      if (item.children) {
        const found = findItemByPath(item.children, path);
        if (found) return found;
      }
    }
    return null;
  };

  const handleCheckboxChange = (itemPath: string, isChecked: boolean) => {
    const newSelectedPathsUpdate = { ...selectedPaths };
    const item = findItemByPath(directoryStructure, itemPath);

    if (!item) return;

    // Recursive function to apply selection
    function setRecursiveSelection(
      currentItem: DirectoryItem,
      select: boolean,
    ) {
      if (currentItem.type === 'file') {
        newSelectedPathsUpdate[currentItem.path] = select;
      } else {
        // Directory
        newSelectedPathsUpdate[currentItem.path] = select
          ? 'SELECTED'
          : 'UNSELECTED';
        // Apply to already loaded children
        if (currentItem.children) {
          currentItem.children.forEach((child) =>
            setRecursiveSelection(child, select),
          );
        }
      }
    }

    setRecursiveSelection(item, isChecked);
    setSelectedPaths(newSelectedPathsUpdate);
  };

  const handleUpdateChaTVars = async () => {
    let filesToLoad: string[] = [];
    const directoriesToLoad: string[] = [];

    Object.entries(selectedPaths).forEach(([path, selectionState]) => {
      const item = findItemByPath(directoryStructure, path);
      if (item) {
        if (item.type === 'file' && selectionState === true) {
          filesToLoad.push(path);
        } else if (item.type === 'directory' && selectionState === 'SELECTED') {
          directoriesToLoad.push(path);
        }
      }
    });

    // Apply extension filter to explicitly selected files
    if (selectedExtensions.length > 0) {
      filesToLoad = filesToLoad.filter((filePath) =>
        selectedExtensions.some((ext) => filePath.endsWith(ext)),
      );
    }

    if (filesToLoad.length === 0 && directoriesToLoad.length === 0) {
      onUpdateCodeContext(
        'No files or directories selected for context (or matching extension filter).',
      );
      return;
    }

    console.log(
      'Loading content for files (after extension filter):',
      filesToLoad,
    );
    console.log(
      'Loading content for directories (backend will filter by ext):',
      directoriesToLoad,
    );

    try {
      const payload: {
        paths?: string[];
        directoryPaths?: string[];
        extensions?: string[];
      } = {};
      if (filesToLoad.length > 0) {
        payload.paths = filesToLoad;
      }
      if (directoriesToLoad.length > 0) {
        payload.directoryPaths = directoriesToLoad;
      }
      if (selectedExtensions.length > 0) {
        payload.extensions = selectedExtensions;
      }

      const response = await fetch('/api/load-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(
          errorData.error ||
            `Failed to load file contents: ${response.statusText}`,
        );
      }
      const data = await response.json();
      onUpdateCodeContext(
        data.context || 'Failed to load content for selected files.',
      );
      if (data.loadErrors) {
        // TODO: Display these errors to the user more gracefully
        console.error('Errors loading some files:', data.loadErrors);
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        onUpdateCodeContext(`Error updating context: ${err.message}`);
      } else {
        onUpdateCodeContext(
          'An unknown error occurred while updating context.',
        );
      }
    }
  };

  // --- ContextEditor Return Statement ---
  return (
    <div className="p-4 flex flex-col h-full">
      <div className="mb-4">
        <label
          htmlFor="dirPath"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Directory Path (relative to project root e.g.,
          `examples/next-chat-app` or `packages/core`):
        </label>
        <div className="mt-1 flex rounded-md shadow-sm">
          <input
            type="text"
            name="dirPath"
            id="dirPath"
            className="focus:ring-indigo-500 focus:border-indigo-500 flex-1 block w-full rounded-none rounded-l-md sm:text-sm border-gray-300 dark:bg-gray-700 dark:border-gray-600 dark:text-white p-2"
            value={dirPath}
            onChange={(e) => setDirPath(e.target.value)}
            placeholder="e.g., ."
          />
          <button
            type="button"
            onClick={handleLoadDirectory}
            disabled={isLoadingDirectory}
            className="inline-flex items-center px-4 py-2 border border-l-0 border-gray-300 dark:border-gray-600 rounded-r-md bg-gray-50 dark:bg-gray-700 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50"
          >
            {isLoadingDirectory ? (
              <RefreshCw size={18} className="animate-spin" />
            ) : (
              'Load'
            )}
          </button>
        </div>
      </div>

      {errorLoadingDirectory && (
        <div className="my-2 p-3 bg-red-100 border border-red-400 text-red-700 rounded">
          Error: {errorLoadingDirectory}
        </div>
      )}

      <div className="mb-4 p-3 border rounded-md bg-gray-50 dark:bg-gray-800">
        <h3 className="text-sm font-semibold mb-2">Filter by Extension:</h3>
        <div className="flex items-center gap-2 mb-2">
          <input
            type="text"
            value={newExtensionInput}
            onChange={(e) => setNewExtensionInput(e.target.value)}
            placeholder="e.g., .ts"
            className="flex-grow p-1.5 border border-gray-300 rounded-md text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-white"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addExtension();
              }
            }}
          />
          <button
            type="button"
            onClick={addExtension}
            className="px-3 py-1.5 bg-blue-500 text-white text-sm rounded-md hover:bg-blue-600"
          >
            Add
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {selectedExtensions.map((ext) => (
            <span
              key={ext}
              className="flex items-center bg-gray-200 dark:bg-gray-600 text-xs px-2 py-1 rounded-full"
            >
              {ext}
              <button
                type="button"
                onClick={() => removeExtension(ext)}
                className="ml-1.5 text-gray-500 dark:text-gray-300 hover:text-red-500 dark:hover:text-red-400 focus:outline-none"
                aria-label={`Remove ${ext} filter`}
              >
                &times; {/* Multiplication sign for 'x' */}
              </button>
            </span>
          ))}
        </div>
        {selectedExtensions.length === 0 && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            No extensions selected, all chosen files will be included.
          </p>
        )}
      </div>

      <div className="flex-1 border rounded-md p-2 overflow-y-auto bg-gray-50 dark:bg-gray-800 mb-4">
        <h3 className="text-sm font-semibold mb-2">Directory Structure:</h3>
        {directoryStructure.length > 0 ? (
          <ul className="list-none p-0">
            {directoryStructure.map((item) => (
              <DirectoryTreeItemComponent
                key={item.path}
                item={item}
                selectedPaths={selectedPaths}
                onCheckboxChange={handleCheckboxChange}
                onToggleExpand={toggleExpandAndLoadChildren}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {isLoadingDirectory ? 'Loading...' : 'Enter a path and click Load.'}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={handleUpdateChaTVars}
        className="w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50 disabled:opacity-50"
        disabled={Object.values(selectedPaths).every(
          (v) => v !== true && v !== 'SELECTED',
        )}
      >
        Update Chat Context with Selected Files
      </button>
    </div>
  );
} // End of ContextEditor component definition

// --- DirectoryTreeItem Component (Refactored) ---
interface DirectoryTreeItemProps {
  item: DirectoryItem;
  selectedPaths: Record<string, boolean | 'SELECTED' | 'UNSELECTED'>;
  onCheckboxChange: (itemPath: string, isChecked: boolean) => void;
  onToggleExpand: (itemPath: string) => void;
}

const DirectoryTreeItemComponent: React.FC<DirectoryTreeItemProps> = ({
  item,
  selectedPaths,
  onCheckboxChange,
  onToggleExpand,
}) => {
  const checkboxRef = useRef<HTMLInputElement>(null);

  const getLocalDirectoryCheckboxState = (
    dirItem: DirectoryItem,
    currentSelectedPaths: Record<string, boolean | 'SELECTED' | 'UNSELECTED'>,
  ): { checked: boolean; indeterminate: boolean } => {
    const selfPath = dirItem.path;
    const selfState = currentSelectedPaths[selfPath];

    if (selfState === 'SELECTED')
      return { checked: true, indeterminate: false };
    if (selfState === 'UNSELECTED')
      return { checked: false, indeterminate: false };

    if (!dirItem.children || dirItem.children.length === 0) {
      return { checked: false, indeterminate: false };
    }

    let allChildrenEffectivelyChecked = true;
    let someChildIsSelectedOrIndeterminate = false;
    let hasFiles = false;
    // let allFilesChecked = true; // This variable was not used

    for (const child of dirItem.children) {
      let childChecked = false;
      let childIndeterminate = false;

      if (child.type === 'file') {
        hasFiles = true;
        childChecked = currentSelectedPaths[child.path] === true;
        // if (!childChecked) allFilesChecked = false; // This variable was not used
      } else {
        // Directory child
        const childDirRecursiveState = getLocalDirectoryCheckboxState(
          child,
          currentSelectedPaths,
        );
        childChecked = childDirRecursiveState.checked;
        childIndeterminate = childDirRecursiveState.indeterminate;
      }

      if (childChecked) {
        someChildIsSelectedOrIndeterminate = true;
      } else {
        allChildrenEffectivelyChecked = false;
      }
      if (childIndeterminate) {
        someChildIsSelectedOrIndeterminate = true;
        allChildrenEffectivelyChecked = false;
      }
    }

    if (dirItem.children.length === 0 && !hasFiles) {
      return { checked: false, indeterminate: false };
    }

    if (allChildrenEffectivelyChecked)
      return { checked: true, indeterminate: false };
    if (someChildIsSelectedOrIndeterminate)
      return { checked: false, indeterminate: true };

    return { checked: false, indeterminate: false };
  };

  let isChecked = false;
  let isIndeterminate = false;

  if (item.type === 'file') {
    isChecked = selectedPaths[item.path] === true;
    isIndeterminate = false;
  } else {
    const dirState = getLocalDirectoryCheckboxState(item, selectedPaths);
    isChecked = dirState.checked;
    isIndeterminate = dirState.indeterminate;
  }

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = isIndeterminate;
    }
  }, [isIndeterminate, isChecked]);

  return (
    <li style={{ marginLeft: `${item.level * 1.5}rem` }}>
      <div className="my-1 flex items-center">
        <input
          type="checkbox"
          className="mr-2"
          ref={checkboxRef}
          checked={isChecked}
          onChange={(e) => onCheckboxChange(item.path, e.target.checked)}
        />
        {item.type === 'directory' ? (
          <button
            onClick={() => onToggleExpand(item.path)}
            className="mr-1 focus:outline-none p-0.5"
          >
            {item.isLoadingChildren ? (
              <RefreshCw size={16} className="animate-spin" />
            ) : item.isExpanded ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronRight size={16} />
            )}
          </button>
        ) : (
          <span className="w-5 mr-1 inline-block"></span>
        )}
        {item.type === 'directory' ? (
          <Folder size={18} className="mr-1 text-yellow-500" />
        ) : (
          <FileIcon size={18} className="mr-1 text-blue-500" />
        )}
        <span
          className={`cursor-pointer ${item.type === 'directory' ? 'hover:underline' : ''}`}
          onClick={() => item.type === 'directory' && onToggleExpand(item.path)}
        >
          {item.name}
        </span>
      </div>
      {item.isExpanded && item.children && item.children.length > 0 && (
        <ul className="pl-0">
          {item.children.map((child) => (
            <DirectoryTreeItemComponent
              key={child.path}
              item={child}
              selectedPaths={selectedPaths}
              onCheckboxChange={onCheckboxChange}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </ul>
      )}
      {item.isExpanded &&
        item.type === 'directory' &&
        !item.isLoadingChildren &&
        (!item.children || item.children.length === 0) && (
          <p
            className="text-xs text-gray-400"
            style={{ marginLeft: `${(item.level + 1) * 1.5 + 0.75}rem` }}
          >
            {item.children && item.children.length === 0
              ? 'Empty directory'
              : 'No children loaded.'}
          </p>
        )}
    </li>
  );
};

// Main page component
export default function Page() {
  // Renamed back to Page
  const [activeTab, setActiveTab] = useState<'chat' | 'context'>('chat');
  const [codeContext, setCodeContext] = useState<string>('');
  const [tokenCount, setTokenCount] = useState<number>(0); // State for token count
  const [isLoadingInitialContext, setIsLoadingInitialContext] =
    useState<boolean>(true);
  const initialDefaulTVarsLoaded = useRef(false);

  // useChat hook setup
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading: isLoadingChat,
    error: chatError,
  } = useChat({
    // Removed setMessages
    api: '/api/chat',
    body: {
      codeContext: codeContext, // Dynamically pass the current codeContext
    },
    initialMessages: [], // Start with no messages, context will be loaded
    onFinish: () => {
      // Potentially clear input or other actions
    },
  });

  // Effect to load default README.md context ONCE on initial mount
  useEffect(() => {
    if (!initialDefaulTVarsLoaded.current) {
      initialDefaulTVarsLoaded.current = true;
      console.log('Fetching initial default code context (README.md)...');
      fetch('/api/load-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: ['README.md'] }), // Default to root README
      })
        .then((res) => {
          if (!res.ok)
            throw new Error(
              `Failed to load default context: ${res.statusText}`,
            );
          return res.json();
        })
        .then((data) => {
          console.log('Default context loaded:', data.context);
          setCodeContext(data.context || 'Failed to load default context.');
        })
        .catch((error: unknown) => {
          console.error('Error loading default context:', error);
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          setCodeContext(`Error loading default context: ${errorMessage}`);
        })
        .finally(() => {
          setIsLoadingInitialContext(false);
        });
    }
  }, []);

  // Effect to calculate token count when codeContext changes
  useEffect(() => {
    if (codeContext) {
      try {
        const enc = get_encoding('cl100k_base');
        const tokens = enc.encode(codeContext);
        setTokenCount(tokens.length);
        enc.free(); // Important to free the encoder to prevent memory leaks
      } catch (e) {
        console.error('Error calculating token count:', e);
        setTokenCount(0); // Reset on error
      }
    } else {
      setTokenCount(0);
    }
  }, [codeContext]);

  const handleUpdateCodeContext = (newContext: string) => {
    setCodeContext(newContext);
    // Optionally, clear chat messages when context changes
    // setMessages([]); // Example: Clear messages
    // Removed the system message that was previously added here.
    setActiveTab('chat'); // Switch back to chat tab after updating context
  };

  return (
    <div className="flex flex-col w-full max-w-5xl min-h-screen py-8 mx-auto">
      <h1 className="text-2xl font-bold mb-6 text-center">Coding Chat</h1>

      <div className="mb-4 border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex space-x-8" aria-label="Tabs">
          <button
            onClick={() => setActiveTab('chat')}
            className={`${
              activeTab === 'chat'
                ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:border-gray-600'
            } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
          >
            Chat
          </button>
          <button
            onClick={() => setActiveTab('context')}
            className={`${
              activeTab === 'context'
                ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:border-gray-600'
            } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm`}
          >
            Context Editor
          </button>
        </nav>
      </div>

      <div className="flex-grow">
        {' '}
        {/* This div will take remaining height */}
        {isLoadingInitialContext && activeTab === 'chat' ? (
          <div className="flex flex-col items-center justify-center h-full">
            <p className="text-gray-500 dark:text-gray-400">
              Loading initial context...
            </p>
          </div>
        ) : (
          <>
            {activeTab === 'chat' && (
              <ChatInterface
                initialCodeContext={codeContext}
                messages={messages}
                input={input}
                handleInputChange={handleInputChange}
                handleSubmit={handleSubmit}
                isLoading={isLoadingChat}
                error={chatError}
                tokenCount={tokenCount} // Pass tokenCount to ChatInterface
              />
            )}
            {activeTab === 'context' && (
              <ContextEditor onUpdateCodeContext={handleUpdateCodeContext} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
