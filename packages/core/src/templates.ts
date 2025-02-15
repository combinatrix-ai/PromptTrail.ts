import type { Message } from './types';
import type { Session } from './session';

/**
 * Base class for all templates
 */
export abstract class Template {
  protected llm?: {
    generate: (prompt: string) => Promise<string>;
  };

  constructor(options?: {
    llm?: {
      generate: (prompt: string) => Promise<string>;
    };
  }) {
    this.llm = options?.llm;
  }

  abstract execute(session: Session): Promise<Session>;
}

/**
 * Template for system messages
 */
export class SystemTemplate extends Template {
  constructor(private options: { content: string }) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    return session.addMessage({
      type: 'system',
      content: this.options.content,
      metadata: {}
    });
  }
}

/**
 * Template for user messages
 */
export class UserTemplate extends Template {
  constructor(private options: {
    description: string;
    default: string;
  }) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    // In a real implementation, this would interact with the user
    // For testing, we use the default value
    return session.addMessage({
      type: 'user',
      content: this.options.default,
      metadata: {}
    });
  }
}

/**
 * Template for assistant messages
 */
export class AssistantTemplate extends Template {
  constructor(private options?: {
    content?: string;
    llm?: {
      generate: (prompt: string) => Promise<string>;
    };
  }) {
    super(options);
  }

  async execute(session: Session): Promise<Session> {
    if (this.options?.content) {
      // For fixed content responses, don't add control messages
      return session.addMessage({
        type: 'assistant',
        content: this.options.content,
        metadata: {}
      });
    }

    if (!this.llm) {
      throw new Error('No LLM provided for AssistantTemplate');
    }

    const response = await this.llm.generate(
      session.getLastMessage()?.content ?? ''
    );

    return session.addMessage({
      type: 'assistant',
      content: response,
      metadata: {}
    });
  }
}

/**
 * Template for linear sequence of templates
 */
export class LinearTemplate extends Template {
  constructor(private templates: Template[]) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    let currentSession = session;
    for (const template of this.templates) {
      currentSession = await template.execute(currentSession);
    }
    return currentSession;
  }
}

/**
 * Template for looping sequence of templates
 */
export class LoopTemplate extends Template {
  constructor(private options: {
    templates: Template[];
    exitCondition: (session: Session) => boolean;
  }) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    let currentSession = session;
    
    do {
      for (const template of this.options.templates) {
        currentSession = await template.execute(currentSession);
      }
    } while (!this.options.exitCondition(currentSession));
    
    return currentSession;
  }
}