import { InputSource } from '@prompttrail/core';
import { useSessionStore } from './sessionStore';

/**
 * Custom InputSource that returns a predefined value
 * This allows us to intercept the InputSource calls and provide our own input
 */
export class CustomInputSource implements InputSource {
  private userInput: string;
  private resolveInput: ((value: string) => void) | null = null;

  constructor(userInput: string) {
    this.userInput = userInput;
  }

  /**
   * Set the user input value
   */
  setUserInput(input: string): void {
    console.log('Setting user input:', input);
    this.userInput = input;

    // If there's a pending input request, resolve it
    if (this.resolveInput) {
      console.log('Resolving pending input request');
      this.resolveInput(input);
      this.resolveInput = null;

      // Set waiting for input to false
      useSessionStore.getState().setWaitingForUserInput(false);
    } else {
      console.log('No pending input request to resolve');
    }
  }

  /**
   * Get input from the user
   * This will be called by the UserTemplate when it needs input
   */
  async getInput(options: {
    description: string;
    defaultValue?: string;
    metadata: Record<string, unknown>;
  }): Promise<string> {
    // Log the input request for debugging
    console.log('Input requested:', options);

    // Don't add a system message with the description as it's redundant
    // Just set waiting for input to true
    console.log('Setting waitingForUserInput to true');
    useSessionStore.getState().setWaitingForUserInput(true);

    // If we already have input, use it
    if (this.userInput) {
      console.log('Using existing user input:', this.userInput);
      const input = this.userInput;
      this.userInput = ''; // Clear the input for next time

      // Don't add the user message to the chat here, it will be added by the session

      // Set waiting for input to false
      useSessionStore.getState().setWaitingForUserInput(false);

      return input;
    }

    // Otherwise, wait for input
    return new Promise<string>((resolve) => {
      this.resolveInput = resolve;
    });
  }
}

/**
 * Create a singleton instance of the CustomInputSource
 * This allows us to update the input value from anywhere in the application
 */
export const customInputSource = new CustomInputSource('');
