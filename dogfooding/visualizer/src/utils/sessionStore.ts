import { create } from 'zustand';
import { OpenAIModel, Session } from '@prompttrail/core';

// Define a message type for the chat interface
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface SessionState {
  // API keys
  openaiApiKey: string;
  anthropicApiKey: string;

  // Session state
  isRunning: boolean;
  currentSession: Session | null;
  sessionOutput: string;
  chatMessages: ChatMessage[];
  waitingForUserInput: boolean;

  // Actions
  setOpenAIApiKey: (key: string) => void;
  setAnthropicApiKey: (key: string) => void;
  startSession: () => void;
  stopSession: () => void;
  setSessionOutput: (output: string) => void;
  appendSessionOutput: (output: string) => void;
  addChatMessage: (
    role: 'system' | 'user' | 'assistant',
    content: string,
  ) => void;
  setWaitingForUserInput: (waiting: boolean) => void;
  resetSession: () => void;

  // Model settings
  selectedModel: string;
  temperature: number;
  setSelectedModel: (model: string) => void;
  setTemperature: (temp: number) => void;

  // Model creation helpers
  createOpenAIModel: () => OpenAIModel | null;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  // Initial state
  openaiApiKey: '',
  anthropicApiKey: '',
  isRunning: false,
  currentSession: null,
  sessionOutput: '',
  chatMessages: [],
  waitingForUserInput: false,
  selectedModel: 'gpt-4o-mini',
  temperature: 0.7,

  // Actions
  setOpenAIApiKey: (key) => set({ openaiApiKey: key }),
  setAnthropicApiKey: (key) => set({ anthropicApiKey: key }),

  startSession: () =>
    set({ isRunning: true, sessionOutput: '', chatMessages: [] }),
  stopSession: () => set({ isRunning: false, waitingForUserInput: false }),

  setSessionOutput: (output) => set({ sessionOutput: output }),
  appendSessionOutput: (output) =>
    set((state) => ({
      sessionOutput: state.sessionOutput + output,
    })),

  addChatMessage: (role, content) =>
    set((state) => ({
      chatMessages: [
        ...state.chatMessages,
        { role, content, timestamp: new Date() },
      ],
    })),

  setWaitingForUserInput: (waiting) => set({ waitingForUserInput: waiting }),

  resetSession: () =>
    set({
      currentSession: null,
      sessionOutput: '',
      chatMessages: [],
      isRunning: false,
      waitingForUserInput: false,
    }),

  // Model settings
  setSelectedModel: (model) => set({ selectedModel: model }),
  setTemperature: (temp) => set({ temperature: temp }),

  // Helper to create an OpenAI model with the stored API key
  createOpenAIModel: () => {
    const { openaiApiKey, selectedModel, temperature } = get();

    if (!openaiApiKey) {
      return null;
    }

    return new OpenAIModel({
      apiKey: openaiApiKey,
      modelName: selectedModel,
      temperature,
      dangerouslyAllowBrowser: true, // Required for browser usage
    });
  },
}));
