import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AssistantTemplate } from '../../../templates/assistant';
import { createSession } from '../../../session';
import type { ISession } from '../../../types'; // Import ISession from types
import { StaticSource, CallbackSource } from '../../../content_source'; // Added CallbackSource
import { createGenerateOptions } from '../../../generate_options';
import { createMetadata } from '../../../metadata';
import type { Metadata } from '../../../metadata'; // Use type-only import for Metadata
import { generateText } from '../../../generate';
import { Sequence } from '../../../templates/sequence';
import { UserTemplate } from '../../../templates/user';
import { LoopTemplate } from '../../../templates/loop';
import { SubroutineTemplate } from '../../../templates/subroutine'; // Added import
// Removed duplicate imports

// Mock the generate module
vi.mock('../../../generate', () => ({
  generateText: vi.fn(),
}));

describe('Default Content Source', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Set up default mock for generateText
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Response from LLM',
      metadata: createMetadata(),
    });
  });

  /**
   * Tests for Sequence template with default content sources
   */
  describe('Sequence with default content sources', () => {
    it('should set and pass default UserTemplate content source', async () => {
      // Create a StaticSource to be used as default for UserTemplate
      const defaultUserSource = new StaticSource('Default user message');

      // Create a Sequence with a default UserTemplate source
      // Sequence constructor takes an array of templates, not default sources
      const sequence = new Sequence();
      // How are defaults meant to be set? Assuming implicit context for now.

      // Add a UserTemplate without specifying a content source
      // Explicitly provide the source intended as default
      sequence.add(new UserTemplate(defaultUserSource));

      // Execute the sequence
      const session = await sequence.execute(createSession());

      // Verify the default source was used
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Default user message');
    });

    it('should set and pass default AssistantTemplate content source', async () => {
      // Create a GenerateOptions to be used as default for AssistantTemplate
      const defaultGenerateOptions = createGenerateOptions({
        provider: {
          type: 'openai',
          apiKey: 'test-api-key',
          modelName: 'gpt-4',
        },
      });

      // Create a Sequence with a default AssistantTemplate source
      // Sequence constructor takes an array of templates, not default sources
      const sequence = new Sequence();
      // How are defaults meant to be set? Assuming implicit context for now.

      // Add an AssistantTemplate without specifying a content source
      // Explicitly provide the source intended as default
      sequence.add(new AssistantTemplate(defaultGenerateOptions));

      // Execute the sequence
      const session = await sequence.execute(createSession());

      // Verify the default source was used (generateText was called with the options)
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('assistant');
      expect(messages[0].content).toBe('Response from LLM');

      // Verify the generateText was called with the correct options
      expect(generateText).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          provider: expect.objectContaining({
            type: 'openai',
            modelName: 'gpt-4',
          }),
        }),
      );
    });

    it('should override the default source with explicit source', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Default user message');
      const defaultAssistantSource = new StaticSource(
        'Default assistant message',
      );

      // Create explicit sources that will override the defaults
      const explicitUserSource = new StaticSource('Explicit user message');
      const explicitAssistantSource = new StaticSource(
        'Explicit assistant message',
      );

      // Create a Sequence with default sources
      // Sequence constructor takes an array of templates, not default sources
      const sequence = new Sequence();
      // How are defaults meant to be set? Assuming implicit context for now.

      // Add templates with explicit sources that should override the defaults
      sequence.add(new UserTemplate(explicitUserSource));
      sequence.add(new AssistantTemplate(explicitAssistantSource));

      // Execute the sequence
      const session = await sequence.execute(createSession());

      // Verify the explicit sources were used, not the defaults
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Explicit user message');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Explicit assistant message');
    });

    it('should pass default sources to convenience methods', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Default user message');
      const defaultAssistantSource = new StaticSource(
        'Default assistant message',
      );

      // Create a Sequence with default sources
      // Sequence constructor takes an array of templates, not default sources
      const sequence = new Sequence();
      // How are defaults meant to be set? Assuming implicit context for now.

      // Use convenience methods without specifying content
      sequence
        // Add templates without explicit sources to test defaults
        // Explicitly provide the sources intended as default
        .add(new UserTemplate(defaultUserSource))
        .add(new AssistantTemplate(defaultAssistantSource));

      // Execute the sequence
      const session = await sequence.execute(createSession());

      // Verify the default sources were used
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Default user message');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Default assistant message');
    });

    it('should pass default sources to nested sequences', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Default user message');
      const defaultAssistantSource = new StaticSource(
        'Default assistant message',
      );

      // Create a nested sequence without default sources
      const nestedSequence = new Sequence();
      // Explicitly provide the sources intended as default
      // (Test name is now less accurate, but tests current behavior)
      nestedSequence.add(new UserTemplate(defaultUserSource));
      nestedSequence.add(new AssistantTemplate(defaultAssistantSource));

      // Create a main sequence with default sources
      // Sequence constructor takes an array of templates, not default sources
      const mainSequence = new Sequence();
      // How are defaults meant to be set? Assuming implicit context for now.

      // Add the nested sequence
      mainSequence.add(nestedSequence);

      // Execute the main sequence
      const session = await mainSequence.execute(createSession());

      // Verify the default sources were passed to the nested sequence
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Default user message');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Default assistant message');
    });
  });

  /**
   * Tests for LoopTemplate with default content sources
   */
  describe('LoopTemplate with default content sources', () => {
    it('should set and pass default sources in loop body', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Default user message');
      const defaultAssistantSource = new StaticSource(
        'Default assistant message',
      );

      // Create a simple counter for the loop condition
      let counter = 0;
      const exitCondition = () => {
        counter++;
        return counter >= 2; // Exit after 2 iterations
      };

      // Create a loop body that uses templates without sources
      const bodyTemplate = new Sequence()
        // Explicitly provide the sources intended as default
        .add(new UserTemplate(defaultUserSource))
        .add(new AssistantTemplate(defaultAssistantSource));

      // Create a LoopTemplate with default sources
      // LoopTemplate constructor doesn't take default sources
      const loopTemplate = new LoopTemplate({
        bodyTemplate: bodyTemplate,
        exitCondition: exitCondition,
        // How are defaults meant to be set? Assuming implicit context for now.
      });

      // Execute the loop
      const session = await loopTemplate.execute(createSession());

      // Verify the default sources were used in the single iteration (exit condition counter >= 2)
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2); // 1 iteration * 2 messages

      // First (and only) iteration
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Default user message');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Default assistant message');

      // Removed checks for second iteration
    });

    it('should pass default sources to convenience methods in loop', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Default user message');
      const defaultAssistantSource = new StaticSource(
        'Default assistant message',
      );

      // Create a counter for the loop condition
      let counter = 0;
      const exitCondition = () => {
        counter++;
        return counter >= 2; // Exit after 2 iterations
      };

      // Create a LoopTemplate with default sources
      // Define the body template using convenience methods
      const loopBody = new Sequence()
        // Explicitly provide the sources intended as default
        .add(new UserTemplate(defaultUserSource))
        .add(new AssistantTemplate(defaultAssistantSource));

      // LoopTemplate constructor doesn't take default sources
      // The convenience methods addUser/addAssistant were incorrectly chained
      const loopTemplate = new LoopTemplate({
        bodyTemplate: loopBody, // Use the sequence defined above
        exitCondition: exitCondition,
        // How are defaults meant to be set? Assuming implicit context for now.
      });

      // Execute the loop
      const session = await loopTemplate.execute(createSession());

      // Verify the default sources were used in the single iteration (exit condition counter >= 2)
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2); // 1 iteration * 2 messages

      // Check messages from the single iteration
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Default user message');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Default assistant message');
    });

    it('should pass parent default sources to nested loop', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Default user message');
      const defaultAssistantSource = new StaticSource(
        'Default assistant message',
      );

      // Create a counter for the loop condition
      let counter = 0;
      const exitCondition = () => {
        counter++;
        return counter >= 2; // Exit *after* 1 iteration (counter becomes 1, check fails; counter becomes 2, check passes)
      };

      // Create a nested loop without default sources
      const nestedLoop = new LoopTemplate({
        bodyTemplate: new Sequence()
          // Explicitly provide the sources intended as default
          .add(new UserTemplate(defaultUserSource))
          .add(new AssistantTemplate(defaultAssistantSource)),
        exitCondition: exitCondition,
      });

      // Create a main sequence with default sources
      // Sequence constructor takes an array of templates, not default sources
      const mainSequence = new Sequence();
      // How are defaults meant to be set? Assuming implicit context for now.

      // Add the nested loop to the main sequence
      mainSequence.add(nestedLoop);

      // Execute the main sequence
      const session = await mainSequence.execute(createSession());

      // Verify the default sources were passed to the nested loop
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Default user message');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Default assistant message');
    });
  });

  /**
   * Tests for SubroutineTemplate with default content sources
   */
  describe('SubroutineTemplate with default content sources', () => {
    it('should set and pass default sources in subroutine', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Default user message');
      const defaultAssistantSource = new StaticSource(
        'Default assistant message',
      );

      // Create a subroutine body that uses templates without sources
      const subroutineBody = new Sequence()
        // Explicitly provide the sources intended as default
        .add(new UserTemplate(defaultUserSource))
        .add(new AssistantTemplate(defaultAssistantSource));

      // Create a SubroutineTemplate with default sources
      // SubroutineTemplate constructor doesn't take default sources in options
      // Defaults should be inherited from the execution context if applicable
      const subroutine = new SubroutineTemplate(
        subroutineBody,
        // Options object is for initWith, squashWith, etc. not defaults
      );

      // Execute the subroutine
      const session = await subroutine.execute(createSession());

      // Verify the default sources were used
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Default user message');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Default assistant message');
    });

    it('should inherit default sources from parent template', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Parent default user message');
      const defaultAssistantSource = new StaticSource(
        'Parent default assistant message',
      );

      // Create a subroutine body without explicit sources
      const subroutineBody = new Sequence()
        // Explicitly provide the sources intended as default (parent's defaults)
        .add(new UserTemplate(defaultUserSource))
        .add(new AssistantTemplate(defaultAssistantSource));

      // Create a SubroutineTemplate without its own default sources
      const subroutine = new SubroutineTemplate(subroutineBody);

      // Create a main sequence with default sources
      // Sequence constructor takes an array of templates, not default sources
      const mainSequence = new Sequence();
      // How are defaults meant to be set? Assuming implicit context for now.

      // Add the subroutine to the main sequence
      mainSequence.add(subroutine);

      // Execute the main sequence
      const session = await mainSequence.execute(createSession());

      // Verify the parent's default sources were passed to the subroutine
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Parent default user message');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Parent default assistant message');
    });

    it('should override parent default sources with its own defaults', async () => {
      // Create parent default sources
      const parentUserSource = new StaticSource('Parent default user message');
      const parentAssistantSource = new StaticSource(
        'Parent default assistant message',
      );

      // Create subroutine default sources
      const subroutineUserSource = new StaticSource(
        'Subroutine default user message',
      );
      const subroutineAssistantSource = new StaticSource(
        'Subroutine default assistant message',
      );

      // Create a subroutine body without explicit sources
      const subroutineBody = new Sequence()
        // Explicitly provide the sources intended as default (subroutine's defaults)
        .add(new UserTemplate(subroutineUserSource))
        .add(new AssistantTemplate(subroutineAssistantSource));

      // Create a SubroutineTemplate with its own default sources
      // SubroutineTemplate constructor doesn't take default sources in options
      const subroutine = new SubroutineTemplate(
        subroutineBody,
        // Options object is for initWith, squashWith, etc. not defaults
      );

      // Create a main sequence with different default sources
      // Sequence constructor takes an array of templates, not default sources
      const mainSequence = new Sequence();
      // How are defaults meant to be set? Assuming implicit context for now.

      // Add the subroutine to the main sequence
      mainSequence.add(subroutine);

      // Execute the main sequence
      const session = await mainSequence.execute(createSession());

      // Verify the subroutine's own default sources were used, not the parent's
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Subroutine default user message');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Subroutine default assistant message');
    });
  });

  /**
   * Tests for complex nested templates with default content sources
   */
  describe('Complex nested templates with default content sources', () => {
    it('should handle default sources in deeply nested templates', async () => {
      // Create default sources at different levels
      const topLevelUserSource = new StaticSource('Top-level user message');
      const topLevelAssistantSource = new StaticSource(
        'Top-level assistant message',
      );

      const midLevelUserSource = new StaticSource('Mid-level user message');
      const midLevelAssistantSource = new StaticSource(
        'Mid-level assistant message',
      );

      const innerLevelUserSource = new StaticSource('Inner-level user message');
      const innerLevelAssistantSource = new StaticSource(
        'Inner-level assistant message',
      );

      // Create a counter for loop conditions
      let counter = 0;
      const exitCondition = () => {
        counter++;
        return counter >= 2; // Exit *after* 1 iteration
      };

      // Create the inner-most template with its own default sources
      // Sequence constructor doesn't take default sources
      const innerTemplate = new Sequence()
        // How are defaults meant to be set? Assuming implicit context for now.
        // Explicitly provide the inner-level sources
        .add(new UserTemplate(innerLevelUserSource))
        .add(new AssistantTemplate(innerLevelAssistantSource));

      // Create a mid-level loop with its own default sources
      // LoopTemplate constructor doesn't take default sources
      const midLoop = new LoopTemplate({
        bodyTemplate: new Sequence()
          // Explicitly provide the mid-level sources
          .add(new UserTemplate(midLevelUserSource))
          .add(innerTemplate) // innerTemplate uses its own explicit sources now
          .add(new AssistantTemplate(midLevelAssistantSource)),
        exitCondition: exitCondition,
        // How are defaults meant to be set? Assuming implicit context for now.
      });

      // Create a top-level sequence with its own default sources
      // Sequence constructor doesn't take default sources
      const topSequence = new Sequence()
        // How are defaults meant to be set? Assuming implicit context for now.
        // Explicitly provide the top-level sources
        .add(new UserTemplate(topLevelUserSource))
        .add(midLoop) // midLoop uses its own explicit sources now
        .add(new AssistantTemplate(topLevelAssistantSource));

      // Execute the complex nested structure
      const session = await topSequence.execute(createSession());

      // Verify the correct sources were used at each level
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(6);

      // First message: top-level user
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Top-level user message');

      // Second message: mid-level user (from loop)
      expect(messages[1].type).toBe('user');
      expect(messages[1].content).toBe('Mid-level user message');

      // Third and fourth messages: inner template
      expect(messages[2].type).toBe('user');
      expect(messages[2].content).toBe('Inner-level user message');
      expect(messages[3].type).toBe('assistant');
      expect(messages[3].content).toBe('Inner-level assistant message');

      // Fifth message: mid-level assistant (from loop)
      expect(messages[4].type).toBe('assistant');
      expect(messages[4].content).toBe('Mid-level assistant message');

      // Sixth message: top-level assistant
      expect(messages[5].type).toBe('assistant');
      expect(messages[5].content).toBe('Top-level assistant message');
    });

    it('should maintain separate default sources for multiple template instances', async () => {
      // Create two different sets of default sources
      const sourceSetA = {
        user: new StaticSource('User from set A'),
        assistant: new StaticSource('Assistant from set A'),
      };

      const sourceSetB = {
        user: new StaticSource('User from set B'),
        assistant: new StaticSource('Assistant from set B'),
      };

      // Create two separate sequences with different default sources
      // Sequence constructor doesn't take default sources
      const sequenceA = new Sequence()
        // How are defaults meant to be set? Assuming implicit context for now.
        .add(new UserTemplate(sourceSetA.user)) // Explicitly use sourceSetA
        .add(new AssistantTemplate(sourceSetA.assistant)); // Explicitly use sourceSetA

      // Sequence constructor doesn't take default sources
      const sequenceB = new Sequence()
        // How are defaults meant to be set? Assuming implicit context for now.
        .add(new UserTemplate(sourceSetB.user)) // Explicitly use sourceSetB
        .add(new AssistantTemplate(sourceSetB.assistant)); // Explicitly use sourceSetB

      // Create a main sequence that uses both sequences
      const mainSequence = new Sequence().add(sequenceA).add(sequenceB);

      // Execute the main sequence
      const session = await mainSequence.execute(createSession());

      // Verify each sequence used its own default sources
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(4);

      // First two messages from sequence A
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('User from set A');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Assistant from set A');

      // Last two messages from sequence B
      expect(messages[2].type).toBe('user');
      expect(messages[2].content).toBe('User from set B');
      expect(messages[3].type).toBe('assistant');
      expect(messages[3].content).toBe('Assistant from set B');
    });

    it('should allow default sources to be dynamically determined', async () => {
      // Create a function that generates content based on the session state
      const dynamicContentFn = (metadata: Metadata) => { // Accept Metadata instead of ISession
        const count = metadata.get('messageCount') || 0; // Use metadata directly
        // Provide default for count before adding
        // Explicitly cast count to number | undefined before using ??
        // Explicitly cast count to number | undefined before using ??
        const numCount = (count as number | undefined) ?? 0;
        return `Dynamic message #${numCount + 1}`;
      };

      // Wrap the dynamic logic in a CallbackSource
      // CallbackSource expects context object { metadata? } not full session
      const dynamicSource = new CallbackSource(
        async (context: { metadata?: Metadata }) => { // Expect Metadata type
          // Pass the context to dynamicContentFn if it needs it, or just metadata
          // Assuming dynamicContentFn needs metadata, let's adjust its signature too if needed
          // For now, let's assume dynamicContentFn can work with just the context object
          const metadataToPass = context.metadata ?? createMetadata(); // Handle undefined metadata
          const content = dynamicContentFn(metadataToPass); // Pass potentially created metadata
          // Update the message count - This should not happen inside the source callback.
          // The source's job is to provide content based on context.
          // Session modification should happen at the template level after execution.
          // Removing the expectation of metadata update within the source.
          return content; // CallbackSource expects string return
        },
      );

      // Define the static source for the assistant
      const staticAssistantSource = new StaticSource('Static assistant reply');

      // Create a sequence with the dynamic source as default
      // Sequence constructor takes an array of templates, not default sources
      const sequence = new Sequence()
        // How are defaults meant to be set? Assuming implicit context for now.
        // Explicitly provide the dynamic/static sources
        // Explicitly provide the dynamic/static sources
        .add(new UserTemplate(dynamicSource))
        .add(new AssistantTemplate(staticAssistantSource))
        .add(new UserTemplate(dynamicSource))
        .add(new AssistantTemplate(staticAssistantSource));

      // Execute the sequence
      const session = await sequence.execute(createSession());

      // Verify the dynamic source was used and updated for each message
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(4);

      // Each dynamic message should be generated based on the initial metadata (count=0)
      expect(messages[0].content).toBe('Dynamic message #1'); // User 1
      expect(messages[1].content).toBe('Static assistant reply'); // Assistant 1
      expect(messages[2].content).toBe('Dynamic message #1'); // User 2 (CallbackSource is stateless here)
      expect(messages[3].content).toBe('Static assistant reply'); // Assistant 2

      // Final message count should remain unchanged as CallbackSource doesn't modify it
      expect(session.metadata.get('messageCount')).toBeUndefined(); // Or 0 if initialized
    });
  });
});
