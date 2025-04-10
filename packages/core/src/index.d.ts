import { z } from 'zod';

// Tool types
export interface Tool<TInput extends z.ZodType<any, any>, TOutput> {
  name: string;
  description: string;
  schema: TInput;
  execute(input: z.infer<TInput>): Promise<ToolExecuteResult<TOutput>>;
}

export interface ToolExecuteResult<T> {
  output?: T;
  error?: string;
}

// Message types
export interface ChatMessage {
  type: string;
  content: string;
}

export interface TMessage extends ChatMessage {
  role: 'user' | 'assistant' | 'system';
}

// Session types
export interface Session {
  messages: ChatMessage[];
  addMessage(message: ChatMessage): Session;
  getLastMessage(): ChatMessage;
}

// Generate options
export interface GenerateOptions {
  provider: {
    type: string;
    apiKey: string;
    modelName: string;
  };
  tools?: Tool<any, any>[];
  temperature?: number;
}

// Template types
export interface Template {
  execute(session: Session): Promise<Session>;
}

export interface BaseTemplate extends Template {
  execute(session: Session): Promise<Session>;
}

// Core classes
export class Agent implements Template {
  add(template: Template): Agent;
  execute(session: Session): Promise<Session>;
}

export class SystemTemplate implements Template {
  constructor(content: string);
  execute(session: Session): Promise<Session>;
}

export class UserTemplate implements Template {
  constructor(content: string | { inputSource: any });
  execute(session: Session): Promise<Session>;
}

export class AssistantTemplate implements Template {
  constructor(options: GenerateOptions);
  execute(session: Session): Promise<Session>;
}

// Core functions
export function createSession(options?: any): Session;
export function createGenerateOptions(
  options: GenerateOptions,
): GenerateOptions;
