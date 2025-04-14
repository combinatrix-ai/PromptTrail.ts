import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AssistantTemplate } from '../../../templates/assistant';
import { createSession } from '../../../session';
import { StaticSource } from '../../../content_source';
import { createGenerateOptions } from '../../../generate_options';
import { createMetadata } from '../../../metadata';
import { generateText } from '../../../generate';
import { Sequence } from '../../../templates/sequence';
import { UserTemplate } from '../../../templates/user';
import { LoopTemplate } from '../../../templates/loop';

// Mock the generate module
vi.mock('../../generate', () => ({
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
      const sequence = new Sequence({
        defaultUserSource: defaultUserSource
      });
      
      // Add a UserTemplate without specifying a content source
      sequence.add(new UserTemplate());
      
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
      const sequence = new Sequence({
        defaultAssistantSource: defaultGenerateOptions
      });
      
      // Add an AssistantTemplate without specifying a content source
      sequence.add(new AssistantTemplate());
      
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
        })
      );
    });

    it('should override the default source with explicit source', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Default user message');
      const defaultAssistantSource = new StaticSource('Default assistant message');
      
      // Create explicit sources that will override the defaults
      const explicitUserSource = new StaticSource('Explicit user message');
      const explicitAssistantSource = new StaticSource('Explicit assistant message');
      
      // Create a Sequence with default sources
      const sequence = new Sequence({
        defaultUserSource: defaultUserSource,
        defaultAssistantSource: defaultAssistantSource
      });
      
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
      const defaultAssistantSource = new StaticSource('Default assistant message');
      
      // Create a Sequence with default sources
      const sequence = new Sequence({
        defaultUserSource: defaultUserSource,
        defaultAssistantSource: defaultAssistantSource
      });
      
      // Use convenience methods without specifying content
      sequence
        .addUser() // Should use default user source
        .addAssistant(); // Should use default assistant source
      
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
      const defaultAssistantSource = new StaticSource('Default assistant message');
      
      // Create a nested sequence without default sources
      const nestedSequence = new Sequence();
      nestedSequence.add(new UserTemplate()); // No explicit source
      nestedSequence.add(new AssistantTemplate()); // No explicit source
      
      // Create a main sequence with default sources
      const mainSequence = new Sequence({
        defaultUserSource: defaultUserSource,
        defaultAssistantSource: defaultAssistantSource
      });
      
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
      const defaultAssistantSource = new StaticSource('Default assistant message');
      
      // Create a simple counter for the loop condition
      let counter = 0;
      const exitCondition = () => {
        counter++;
        return counter >= 2; // Exit after 2 iterations
      };
      
      // Create a loop body that uses templates without sources
      const bodyTemplate = new Sequence()
        .add(new UserTemplate()) // No explicit source
        .add(new AssistantTemplate()); // No explicit source
      
      // Create a LoopTemplate with default sources
      const loopTemplate = new LoopTemplate({
        bodyTemplate: bodyTemplate,
        exitCondition: exitCondition,
        defaultUserSource: defaultUserSource,
        defaultAssistantSource: defaultAssistantSource
      });
      
      // Execute the loop
      const session = await loopTemplate.execute(createSession());
      
      // Verify the default sources were used in both iterations
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(4); // 2 iterations * 2 messages
      
      // First iteration
      expect(messages[0].type).toBe('user');
      expect(messages[0].content).toBe('Default user message');
      expect(messages[1].type).toBe('assistant');
      expect(messages[1].content).toBe('Default assistant message');
      
      // Second iteration
      expect(messages[2].type).toBe('user');
      expect(messages[2].content).toBe('Default user message');
      expect(messages[3].type).toBe('assistant');
      expect(messages[3].content).toBe('Default assistant message');
    });

    it('should pass default sources to convenience methods in loop', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Default user message');
      const defaultAssistantSource = new StaticSource('Default assistant message');
      
      // Create a counter for the loop condition
      let counter = 0;
      const exitCondition = () => {
        counter++;
        return counter >= 2; // Exit after 2 iterations
      };
      
      // Create a LoopTemplate with default sources
      const loopTemplate = new LoopTemplate({
        bodyTemplate: new Sequence(), // Empty placeholder
        exitCondition: exitCondition,
        defaultUserSource: defaultUserSource,
        defaultAssistantSource: defaultAssistantSource
      })
        .addUser() // Should use default user source
        .addAssistant(); // Should use default assistant source
      
      // Execute the loop
      const session = await loopTemplate.execute(createSession());
      
      // Verify the default sources were used in both iterations
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(4); // 2 iterations * 2 messages
      
      // Check all messages use the default sources
      for (let i = 0; i < 4; i += 2) {
        expect(messages[i].type).toBe('user');
        expect(messages[i].content).toBe('Default user message');
        expect(messages[i+1].type).toBe('assistant');
        expect(messages[i+1].content).toBe('Default assistant message');
      }
    });

    it('should pass parent default sources to nested loop', async () => {
      // Create default sources
      const defaultUserSource = new StaticSource('Default user message');
      const defaultAssistantSource = new StaticSource('Default assistant message');
      
      // Create a counter for the loop condition
      let counter = 0;
      const exitCondition = () => {
        counter++;
        return counter >= 1; // Just one iteration to keep the test simple
      };
      
      // Create a nested loop without default sources
      const nestedLoop = new LoopTemplate({
        bodyTemplate: new Sequence()
          .add(new UserTemplate()) // No explicit source
          .add(new AssistantTemplate()), // No explicit source
        exitCondition: exitCondition
      });
      
      // Create a main sequence with default sources
      const mainSequence = new Sequence({
        defaultUserSource: defaultUserSource,
        defaultAssistantSource: defaultAssistantSource
      });
      
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
      const defaultAssistantSource = new StaticSource('Default assistant message');
      
      // Create a subroutine body that uses templates without sources
      const subroutineBody = new Sequence()
        .add(new UserTemplate()) // No explicit source
        .add(new AssistantTemplate()); // No explicit source
      
      // Create a SubroutineTemplate with default sources
      const subroutine = new SubroutineTemplate(
        subroutineBody,
        {
          defaultUserSource: defaultUserSource,
          defaultAssistantSource: defaultAssistantSource
        }
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
      const defaultAssistantSource = new StaticSource('Parent default assistant message');
      
      // Create a subroutine body without explicit sources
      const subroutineBody = new Sequence()
        .add(new UserTemplate()) // No explicit source
        .add(new AssistantTemplate()); // No explicit source
      
      // Create a SubroutineTemplate without its own default sources
      const subroutine = new SubroutineTemplate(subroutineBody);
      
      // Create a main sequence with default sources
      const mainSequence = new Sequence({
        defaultUserSource: defaultUserSource,
        defaultAssistantSource: defaultAssistantSource
      });
      
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
      const parentAssistantSource = new StaticSource('Parent default assistant message');
      
      // Create subroutine default sources
      const subroutineUserSource = new StaticSource('Subroutine default user message');
      const subroutineAssistantSource = new StaticSource('Subroutine default assistant message');
      
      // Create a subroutine body without explicit sources
      const subroutineBody = new Sequence()
        .add(new UserTemplate()) // No explicit source
        .add(new AssistantTemplate()); // No explicit source
      
      // Create a SubroutineTemplate with its own default sources
      const subroutine = new SubroutineTemplate(
        subroutineBody,
        {
          defaultUserSource: subroutineUserSource,
          defaultAssistantSource: subroutineAssistantSource
        }
      );
      
      // Create a main sequence with different default sources
      const mainSequence = new Sequence({
        defaultUserSource: parentUserSource,
        defaultAssistantSource: parentAssistantSource
      });
      
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
      const topLevelAssistantSource = new StaticSource('Top-level assistant message');
      
      const midLevelUserSource = new StaticSource('Mid-level user message');
      const midLevelAssistantSource = new StaticSource('Mid-level assistant message');
      
      const innerLevelUserSource = new StaticSource('Inner-level user message');
      const innerLevelAssistantSource = new StaticSource('Inner-level assistant message');
      
      // Create a counter for loop conditions
      let counter = 0;
      const exitCondition = () => {
        counter++;
        return counter >= 1; // Just one iteration to keep the test simple
      };
      
      // Create the inner-most template with its own default sources
      const innerTemplate = new Sequence({
        defaultUserSource: innerLevelUserSource,
        defaultAssistantSource: innerLevelAssistantSource
      })
        .add(new UserTemplate()) // Should use inner-level source
        .add(new AssistantTemplate()); // Should use inner-level source
      
      // Create a mid-level loop with its own default sources
      const midLoop = new LoopTemplate({
        bodyTemplate: new Sequence()
          .add(new UserTemplate()) // Should use mid-level source
          .add(innerTemplate) // This has its own sources
          .add(new AssistantTemplate()), // Should use mid-level source
        exitCondition: exitCondition,
        defaultUserSource: midLevelUserSource,
        defaultAssistantSource: midLevelAssistantSource
      });
      
      // Create a top-level sequence with its own default sources
      const topSequence = new Sequence({
        defaultUserSource: topLevelUserSource,
        defaultAssistantSource: topLevelAssistantSource
      })
        .add(new UserTemplate()) // Should use top-level source
        .add(midLoop) // This has its own sources
        .add(new AssistantTemplate()); // Should use top-level source
      
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
        assistant: new StaticSource('Assistant from set A')
      };
      
      const sourceSetB = {
        user: new StaticSource('User from set B'),
        assistant: new StaticSource('Assistant from set B')
      };
      
      // Create two separate sequences with different default sources
      const sequenceA = new Sequence({
        defaultUserSource: sourceSetA.user,
        defaultAssistantSource: sourceSetA.assistant
      })
        .add(new UserTemplate()) // Should use set A
        .add(new AssistantTemplate()); // Should use set A
      
      const sequenceB = new Sequence({
        defaultUserSource: sourceSetB.user,
        defaultAssistantSource: sourceSetB.assistant
      })
        .add(new UserTemplate()) // Should use set B
        .add(new AssistantTemplate()); // Should use set B
      
      // Create a main sequence that uses both sequences
      const mainSequence = new Sequence()
        .add(sequenceA)
        .add(sequenceB);
      
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
      const dynamicContentFn = (session: Session) => {
        const count = session.metadata.get('messageCount') || 0;
        return `Dynamic message #${count + 1}`;
      };
      
      // Create a dynamic source that updates with each use
      const dynamicSource = {
        getContent: async (session: Session) => {
          const content = dynamicContentFn(session);
          // Update the message count
          session.updateMetadata({
            messageCount: (session.metadata.get('messageCount') || 0) + 1
          });
          return content;
        }
      };
      
      // Create a sequence with the dynamic source as default
      const sequence = new Sequence({
        defaultUserSource: dynamicSource,
        defaultAssistantSource: dynamicSource
      })
        .add(new UserTemplate()) // Should use dynamic source
        .add(new AssistantTemplate()) // Should use dynamic source
        .add(new UserTemplate()) // Should use dynamic source
        .add(new AssistantTemplate()); // Should use dynamic source
      
      // Execute the sequence
      const session = await sequence.execute(createSession());
      
      // Verify the dynamic source was used and updated for each message
      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(4);
      
      // Each message should have an incremented number
      expect(messages[0].content).toBe('Dynamic message #1');
      expect(messages[1].content).toBe('Dynamic message #2');
      expect(messages[2].content).toBe('Dynamic message #3');
      expect(messages[3].content).toBe('Dynamic message #4');
      
      // Final message count should be 4
      expect(session.metadata.get('messageCount')).toBe(4);
    });
  });
});