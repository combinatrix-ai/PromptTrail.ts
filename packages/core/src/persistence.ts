// persistence.ts
import type { Session, Vars, Attrs, SessionUsage } from './session';
import { Session as SessionFactory } from './session';

/**
 * Serialized session data for database storage
 */
export interface SerializedSession {
  id?: string;
  messages: any[];
  vars: Record<string, unknown>;
  usage: SessionUsage;
  createdAt?: Date | string;
  updatedAt?: Date | string;
  metadata?: Record<string, unknown>;
}

/**
 * Interface for database adapters
 */
export interface PersistenceAdapter {
  /**
   * Save a session to the database
   * @param session The session to save
   * @param sessionId Optional session ID (if undefined, create new)
   * @returns The session ID
   */
  save(session: SerializedSession, sessionId?: string): Promise<string>;

  /**
   * Load a session from the database
   * @param sessionId The session ID to load
   * @returns The serialized session data
   */
  load(sessionId: string): Promise<SerializedSession | null>;

  /**
   * Delete a session from the database
   * @param sessionId The session ID to delete
   */
  delete(sessionId: string): Promise<void>;

  /**
   * List all session IDs
   * @returns Array of session IDs
   */
  list(): Promise<string[]>;
}

/**
 * Session persistence manager
 */
export class SessionPersistence {
  constructor(private adapter: PersistenceAdapter) {}

  /**
   * Save a session to the database
   * @param session The session to save
   * @param sessionId Optional session ID (if undefined, create new)
   * @param metadata Optional additional metadata
   * @returns The session ID
   */
  async save<TVars extends Vars, TAttrs extends Attrs>(
    session: Session<TVars, TAttrs>,
    sessionId?: string,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    const serialized: SerializedSession = {
      id: sessionId,
      messages: session.messages as any[],
      vars: session.vars as Record<string, unknown>,
      usage: session.usage,
      updatedAt: new Date(),
      metadata,
    };

    if (!sessionId) {
      serialized.createdAt = new Date();
    }

    return this.adapter.save(serialized, sessionId);
  }

  /**
   * Load a session from the database
   * @param sessionId The session ID to load
   * @returns The restored session or null if not found
   */
  async load<
    TVars extends Record<string, unknown> = {},
    TAttrs extends Record<string, unknown> = {},
  >(sessionId: string): Promise<Session<Vars<TVars>, Attrs<TAttrs>> | null> {
    const data = await this.adapter.load(sessionId);

    if (!data) {
      return null;
    }

    return SessionFactory.fromJSON<TVars, TAttrs>({
      messages: data.messages,
      context: data.vars,
      usage: data.usage,
    });
  }

  /**
   * Delete a session from the database
   * @param sessionId The session ID to delete
   */
  async delete(sessionId: string): Promise<void> {
    return this.adapter.delete(sessionId);
  }

  /**
   * List all session IDs
   * @returns Array of session IDs
   */
  async list(): Promise<string[]> {
    return this.adapter.list();
  }

  /**
   * Get metadata for a session without loading the full session
   * @param sessionId The session ID
   * @returns The serialized session data (including metadata)
   */
  async getMetadata(sessionId: string): Promise<SerializedSession | null> {
    return this.adapter.load(sessionId);
  }
}

/**
 * In-memory persistence adapter (for testing/development)
 */
export class InMemoryAdapter implements PersistenceAdapter {
  private sessions = new Map<string, SerializedSession>();
  private nextId = 1;

  async save(
    session: SerializedSession,
    sessionId?: string,
  ): Promise<string> {
    const id = sessionId || `session_${this.nextId++}`;
    this.sessions.set(id, { ...session, id });
    return id;
  }

  async load(sessionId: string): Promise<SerializedSession | null> {
    return this.sessions.get(sessionId) || null;
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async list(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }

  /**
   * Clear all sessions (for testing)
   */
  clear(): void {
    this.sessions.clear();
    this.nextId = 1;
  }
}

/**
 * Example JSON file adapter (Node.js only)
 */
export class JSONFileAdapter implements PersistenceAdapter {
  private sessions = new Map<string, SerializedSession>();
  private filePath: string;
  private nextId = 1;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadFromFile();
  }

  private loadFromFile(): void {
    try {
      const fs = require('fs');
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(data);
        this.sessions = new Map(Object.entries(parsed.sessions || {}));
        this.nextId = parsed.nextId || 1;
      }
    } catch (error) {
      console.warn('Failed to load sessions from file:', error);
    }
  }

  private saveToFile(): void {
    try {
      const fs = require('fs');
      const data = {
        sessions: Object.fromEntries(this.sessions),
        nextId: this.nextId,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save sessions to file:', error);
      throw error;
    }
  }

  async save(
    session: SerializedSession,
    sessionId?: string,
  ): Promise<string> {
    const id = sessionId || `session_${this.nextId++}`;
    this.sessions.set(id, { ...session, id });
    this.saveToFile();
    return id;
  }

  async load(sessionId: string): Promise<SerializedSession | null> {
    return this.sessions.get(sessionId) || null;
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.saveToFile();
  }

  async list(): Promise<string[]> {
    return Array.from(this.sessions.keys());
  }
}

/**
 * Helper function to create a persistence manager with in-memory storage
 */
export function createInMemoryPersistence(): SessionPersistence {
  return new SessionPersistence(new InMemoryAdapter());
}

/**
 * Helper function to create a persistence manager with JSON file storage
 */
export function createJSONFilePersistence(
  filePath: string,
): SessionPersistence {
  return new SessionPersistence(new JSONFileAdapter(filePath));
}
