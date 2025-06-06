import type { Session } from '../session';
import type { InkDebugRenderer } from './ink-debug-renderer';

/**
 * Terminal capability detection
 */
function isTerminalCapable(): boolean {
  // Check if we're in a proper terminal environment
  // Handle cases where process.stdout.isTTY might be undefined
  const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
  const termNotDumb = process.env.TERM !== 'dumb';
  const notCI = !process.env.CI;
  const notTest = !process.env.NODE_ENV?.includes('test');

  return isTTY && termNotDumb && notCI && notTest;
}

/**
 * Global singleton to coordinate Ink debug interface across the application
 */
class InkDebugContextManager {
  private static instance: InkDebugContextManager | null = null;
  private renderer: InkDebugRenderer | null = null;
  private activeSession: Session | null = null;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;
  private initializationStarted = false;

  /**
   * Initialize the Ink debug context with a session
   */
  static async initialize(session: Session<any, any>): Promise<void> {
    if (!this.instance) {
      this.instance = new InkDebugContextManager();
    }

    // Mark that initialization has started
    this.instance.initializationStarted = true;

    // If initialization is already in progress, wait for it
    if (this.instance.initializationPromise) {
      await this.instance.initializationPromise;
      return;
    }

    // Start initialization
    this.instance.initializationPromise =
      this.instance.startInkInterface(session);
    await this.instance.initializationPromise;
  }

  /**
   * Check if Ink debug interface is currently active
   */
  static isActive(): boolean {
    return (
      (this.instance?.isInitialized && this.instance?.renderer?.isRunning()) ||
      false
    );
  }

  /**
   * Check if initialization has been started (even if not complete)
   */
  static isInitializationStarted(): boolean {
    return this.instance?.initializationStarted || false;
  }

  /**
   * Wait for Ink initialization to complete if in progress
   */
  static async waitForInitialization(): Promise<boolean> {
    if (!this.instance) {
      return false;
    }

    if (this.instance.initializationPromise) {
      try {
        await this.instance.initializationPromise;
        return this.isActive();
      } catch (error) {
        // Initialization failed, return false
        return false;
      }
    }

    return this.isActive();
  }

  /**
   * Capture user input through the Ink interface
   */
  static async captureCliInput(
    prompt: string,
    defaultValue?: string,
    session?: Session<any, any>,
  ): Promise<string> {
    if (!this.instance?.renderer) {
      throw new Error(
        'Ink debug context not initialized - call Session.debug() first',
      );
    }

    return this.instance.renderer.getUserInput(prompt, defaultValue, session);
  }

  /**
   * Update the conversation display with new session state
   */
  static updateSession(session: Session<any, any>): void {
    if (this.instance?.renderer) {
      this.instance.activeSession = session;
      this.instance.renderer.updateConversation(session);
    }
  }

  /**
   * Check if terminal supports Ink interface
   */
  static isTerminalCapable(): boolean {
    return isTerminalCapable();
  }

  /**
   * Cleanup and shutdown the Ink interface
   */
  static async shutdown(): Promise<void> {
    if (this.instance?.renderer) {
      await this.instance.renderer.shutdown();
      this.instance.renderer = null;
      this.instance.isInitialized = false;
    }
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static reset(): void {
    this.instance = null;
  }

  /**
   * Start the Ink interface with the given session
   */
  private async startInkInterface(session: Session<any, any>): Promise<void> {
    try {
      if (this.isInitialized) {
        // Update existing interface instead of creating new one
        InkDebugContextManager.updateSession(session);
        return;
      }

      if (!isTerminalCapable()) {
        throw new Error(
          'Terminal does not support Ink interface - falling back to console mode',
        );
      }

      this.activeSession = session;

      // Lazy load the renderer to avoid loading React/Ink in non-UI contexts
      const { InkDebugRenderer } = await import('./ink-debug-renderer');
      this.renderer = new InkDebugRenderer(session);

      await this.renderer.start();
      this.isInitialized = true;
    } finally {
      // Clear the initialization promise when done (success or failure)
      this.initializationPromise = null;
    }
  }

  /**
   * Get the current active session
   */
  getActiveSession(): Session<any, any> | null {
    return this.activeSession;
  }
}

export { InkDebugContextManager as InkDebugContext };
