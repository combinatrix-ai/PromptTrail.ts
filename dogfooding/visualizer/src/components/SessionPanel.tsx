import React, { useState } from 'react';
import { useSessionStore } from '../utils/sessionStore';
import { useTemplateStore } from '../utils/templateStore';
import {
  LinearTemplate,
  AssistantTemplate,
  UserTemplate,
  OpenAIModel,
} from '@prompttrail/core';
import { customInputSource } from '../utils/customInputSource';
import { createCustomSession } from '../utils/customSession';

const SessionPanel: React.FC = () => {
  const {
    openaiApiKey,
    setOpenAIApiKey,
    isRunning,
    startSession,
    stopSession,
    chatMessages,
    waitingForUserInput,
    addChatMessage,
    setWaitingForUserInput,
    createOpenAIModel,
    selectedModel,
    setSelectedModel,
    temperature,
    setTemperature,
  } = useSessionStore();

  const { generateCode } = useTemplateStore();
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [userPrompt, setUserPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Update the custom input source whenever the user prompt changes and submit button is clicked
  const handleSubmitUserInput = () => {
    if (!userPrompt.trim()) return;

    // Don't add the user message to the chat here, it will be added by the session
    // when the UserTemplate processes the input

    // Update the custom input source
    customInputSource.setUserInput(userPrompt);

    // Clear the input
    setUserPrompt('');
  };

  const handleRunSession = async () => {
    if (!apiKeyInput.trim()) {
      setError('Please enter an OpenAI API key first');
      return;
    }

    try {
      setError(null);

      // Reset the session and clear chat messages
      console.log('Resetting session and clearing chat messages');
      startSession();

      // Set the API key from the input field
      setOpenAIApiKey(apiKeyInput.trim());

      // Create a model
      const model = createOpenAIModel();
      if (!model) {
        throw new Error('Failed to create OpenAI model');
      }

      // Create a custom session that will automatically update the UI
      const session = createCustomSession({ print: false });

      // Instead of trying to evaluate the template code, let's build the template directly from the visualizer state
      try {
        // Get the templates from the store
        const { templates } = useTemplateStore.getState();

        // Create a new LinearTemplate
        const template = new LinearTemplate();

        // Find the root template (should be a Linear template)
        const rootTemplate = templates.find((t) => !t.parentId);
        if (!rootTemplate) {
          throw new Error('No root template found');
        }

        // Get children of the root template, sorted by position
        const children = templates
          .filter((t) => t.parentId === rootTemplate.id)
          .sort((a, b) => a.position - b.position);

        // Process each child
        for (const child of children) {
          switch (child.type) {
            case 'System':
              template.addSystem(
                child.data.content || "You're a helpful assistant.",
              );
              break;

            case 'User':
              // Check the inputType to determine how to handle this User template
              const inputType = child.data.inputType || 'runtime';

              if (inputType === 'runtime') {
                // Use runtime input from the input box with customInputSource
                // Create UserTemplate directly instead of using addUser
                (template as any).templates.push(
                  new UserTemplate({
                    description: child.data.content || 'Your input:',
                    inputSource: customInputSource,
                  }),
                );
              } else {
                // Use fixed input (not replaced at runtime)
                const content = child.data.content || 'Your input:';
                const defaultValue = child.data.default || '';
                template.addUser(content, defaultValue);
              }
              break;

            case 'Assistant':
              if (
                child.data.assistantType === 'content' &&
                child.data.content
              ) {
                template.addAssistant(child.data.content);
              } else {
                // Use the model specified in the AssistantTemplate, or the default model if none is specified
                const assistantModel = child.data.model
                  ? new OpenAIModel({
                      apiKey: openaiApiKey,
                      modelName: child.data.model,
                      temperature: 0.7,
                      dangerouslyAllowBrowser: true,
                    })
                  : model;

                template.addAssistant({ model: assistantModel });
              }
              break;
          }
        }

        // If no templates were added, add default ones
        if (
          (template as any).templates &&
          (template as any).templates.length === 0
        ) {
          // Add system template
          template.addSystem("You're a helpful assistant.");

          // Add user template directly
          (template as any).templates.push(
            new UserTemplate({
              description: 'Your input:',
              inputSource: customInputSource,
            }),
          );

          // Add assistant template
          template.addAssistant({ model });
        }

        // Check if the template has an assistant template or if it's just a system message
        const templateItems = (template as any).templates || [];
        const hasAssistantTemplate = templateItems.some(
          (t: any) => t instanceof AssistantTemplate,
        );
        const hasUserMessage = templateItems.some(
          (t: any) => t.type === 'user',
        );

        // Add debug logging
        console.log('Template structure:', {
          templates: (template as any).templates.map((t: any) => ({
            type: t.constructor.name,
            options: t.options || 'N/A',
          })),
        });

        // Execute the template
        console.log('Executing template...');
        let updatedSession = await template.execute(session);
        console.log('Template execution completed');

        // Only use executeWithModel if there's no AssistantTemplate AND there's at least one user message
        // This prevents generating a response when there's only a system message
        if (!hasAssistantTemplate && hasUserMessage) {
          console.log(
            'No AssistantTemplate found but UserTemplate exists, using executeWithModel',
          );
          updatedSession = await (updatedSession as any).executeWithModel(
            model,
          );
        }
      } catch (templateError) {
        console.error('Error creating or executing template:', templateError);
        throw new Error(
          `Error: ${templateError instanceof Error ? templateError.message : String(templateError)}`,
        );
      }

      stopSession();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'An unknown error occurred',
      );
      stopSession();
    }
  };

  // Function to render chat messages
  const renderChatMessages = () => {
    return chatMessages.map((message, index) => {
      let bgColor = 'bg-gray-100';
      let textAlign = 'text-left';
      let fontWeight = 'font-normal';
      let borderColor = '';

      if (message.role === 'system') {
        bgColor = 'bg-white';
        borderColor = 'border-l-4 border-l-blue-500'; // Match node-system color
        fontWeight = 'font-medium';
      } else if (message.role === 'user') {
        bgColor = 'bg-white';
        borderColor = 'border-l-4 border-l-green-500'; // Match node-user color
        textAlign = 'text-left';
      } else if (message.role === 'assistant') {
        bgColor = 'bg-white';
        borderColor = 'border-l-4 border-l-purple-500'; // Match node-assistant color
      }

      return (
        <div
          key={index}
          className={`p-3 ${bgColor} border rounded-md mb-2 ${textAlign} ${fontWeight} ${borderColor}`}
        >
          <div className="text-xs text-gray-500 mb-1">
            {message.role.charAt(0).toUpperCase() + message.role.slice(1)}
          </div>
          <div className="whitespace-pre-wrap">{message.content}</div>
        </div>
      );
    });
  };

  return (
    <div className="session-panel p-4 bg-white border rounded-md shadow-sm">
      <h2 className="text-lg font-semibold mb-4">Session Control</h2>

      {/* API Key Input */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">
          OpenAI API Key
        </label>
        <input
          type="password"
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
          placeholder="sk-..."
          className={`w-full px-3 py-2 border ${
            apiKeyInput.trim() ? 'border-gray-300' : 'border-red-500'
          } rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500`}
          disabled={isRunning}
        />
      </div>

      {/* Run Button */}
      <div className="mb-4">
        <button
          onClick={handleRunSession}
          disabled={isRunning || !apiKeyInput.trim()}
          className={`w-full px-4 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            isRunning || !apiKeyInput.trim()
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
              : 'bg-green-500 text-white hover:bg-green-600'
          }`}
        >
          {isRunning ? 'Running...' : 'Run Template'}
        </button>
      </div>

      {/* Error Display */}
      {error && (
        <div className="mb-4 p-3 bg-red-100 border border-red-300 text-red-700 rounded-md">
          {error}
        </div>
      )}

      {/* Chat Messages Display */}
      {chatMessages.length > 0 && (
        <div className="mt-4">
          <h3 className="text-md font-medium mb-2">Chat:</h3>
          <div className="p-3 bg-gray-50 border border-gray-200 rounded-md max-h-60 overflow-y-auto">
            {renderChatMessages()}
          </div>
        </div>
      )}

      {/* User Input for Chat */}
      <div className="mt-4">
        <div className="flex flex-col">
          <textarea
            value={userPrompt}
            onChange={(e) => setUserPrompt(e.target.value)}
            placeholder={
              waitingForUserInput
                ? 'Enter your response...'
                : 'Type a message...'
            }
            className={`w-full px-3 py-2 border border-gray-300 rounded-t-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              waitingForUserInput ? 'bg-yellow-50' : ''
            }`}
            rows={3}
            disabled={isRunning && !waitingForUserInput}
            onKeyPress={(e) => {
              if (e.key === 'Enter' && e.shiftKey === false) {
                e.preventDefault();
                handleSubmitUserInput();
              }
            }}
          />
          <button
            onClick={handleSubmitUserInput}
            disabled={isRunning && !waitingForUserInput}
            className={`w-full px-4 py-2 rounded-b-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              isRunning && !waitingForUserInput
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : waitingForUserInput
                  ? 'bg-yellow-500 text-white hover:bg-yellow-600'
                  : 'bg-blue-500 text-white hover:bg-blue-600'
            }`}
          >
            {waitingForUserInput ? 'Respond' : 'Send'}
          </button>
        </div>
        {waitingForUserInput && (
          <p className="text-sm text-yellow-600 mt-1">
            Waiting for your input...
          </p>
        )}
      </div>
    </div>
  );
};

export default SessionPanel;
