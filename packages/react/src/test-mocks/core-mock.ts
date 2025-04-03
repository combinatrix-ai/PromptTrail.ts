
export type Message = {
  type: 'system' | 'user' | 'assistant' | 'tool_result';
  content: string;
  [key: string]: any;
};

export type Metadata = Map<string, any>;

export interface InputSource {
  getInput: (context?: { metadata?: Metadata }) => Promise<string>;
}

export interface Session<T extends Record<string, unknown> = Record<string, unknown>> {
  messages: Message[];
  metadata: Metadata;
  addMessage: (message: Message) => Session<T>;
  getMessagesByType: <U extends Message['type']>(type: U) => Extract<Message, { type: U }>[];
  updateMetadata: (metadata: Partial<T>) => Session<T>;
}

export interface Template<TInput, TOutput> {
  execute: (session: Session<any>) => Promise<Session<any>>;
}

export const createSession = (): Session<any> => {
  const messages: Message[] = [];
  const metadata = new Map<string, any>();
  
  return {
    messages,
    metadata,
    addMessage: (message: Message) => {
      messages.push(message);
      return createSession();
    },
    getMessagesByType: <U extends Message['type']>(type: U) => {
      return messages.filter(m => m.type === type) as Extract<Message, { type: U }>[];
    },
    updateMetadata: (newMetadata: Record<string, any>) => {
      Object.entries(newMetadata).forEach(([key, value]) => {
        metadata.set(key, value);
      });
      return createSession();
    }
  };
};

export class LinearTemplate implements Template<any, any> {
  async execute(session: Session<any>): Promise<Session<any>> {
    return session;
  }
  
  addSystem(content: string): LinearTemplate {
    return this;
  }
  
  addUser(content: string): LinearTemplate {
    return this;
  }
  
  addAssistant(options: any): LinearTemplate {
    return this;
  }
}

export const createGenerateOptions = (options: any) => options;
