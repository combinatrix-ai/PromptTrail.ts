import { describe, it, expect } from 'vitest';
import { think } from '../../../tools/think';

describe('think', () => {
  it('should process basic thought', async () => {
    const result = await (think as any).execute({
      thought: 'How should I approach this problem?',
      thinking_type: 'problem_solving'
    });

    expect(result.thinking_id).toBeDefined();
    expect(result.timestamp).toBeDefined();
    expect(result.thinking_type).toBe('problem_solving');
    expect(result.original_thought).toBe('How should I approach this problem?');
    expect(result.processed_thought).toContain('Problem-solving for: How should I approach this problem?');
    expect(result.insights).toContain('Define the problem clearly');
    expect(result.next_steps).toContain('Identify root cause');
  });

  it('should handle analysis type thinking', async () => {
    const result = await (think as any).execute({
      thought: 'The user seems frustrated with the current UI',
      thinking_type: 'analysis',
      context: 'User feedback session',
      confidence_level: 85
    });

    expect(result.thinking_type).toBe('analysis');
    expect(result.processed_thought).toContain('Analyzing:');
    expect(result.processed_thought).toContain('Context: User feedback session');
    expect(result.confidence_level).toBe(85);
    expect(result.reasoning_quality).toBe('high');
    expect(result.insights).toContain('Consider multiple perspectives');
  });

  it('should handle planning type thinking', async () => {
    const result = await (think as any).execute({
      thought: 'Need to implement new features for next sprint',
      thinking_type: 'planning',
      tags: ['sprint', 'features']
    });

    expect(result.thinking_type).toBe('planning');
    expect(result.processed_thought).toContain('Planning approach for:');
    expect(result.tags).toEqual(['sprint', 'features']);
    expect(result.insights).toContain('Break down into steps');
    expect(result.next_steps).toContain('Define objectives');
  });

  it('should handle reflection type thinking', async () => {
    const result = await (think as any).execute({
      thought: 'The last implementation went really well',
      thinking_type: 'reflection'
    });

    expect(result.thinking_type).toBe('reflection');
    expect(result.processed_thought).toContain('Reflecting on:');
    expect(result.insights).toContain('What worked well?');
    expect(result.next_steps).toContain('Document lessons learned');
  });

  it('should handle decision making type thinking', async () => {
    const result = await (think as any).execute({
      thought: 'Should we use TypeScript or JavaScript for this project?',
      thinking_type: 'decision_making',
      confidence_level: 60
    });

    expect(result.thinking_type).toBe('decision_making');
    expect(result.processed_thought).toContain('Decision analysis:');
    expect(result.reasoning_quality).toBe('medium');
    expect(result.insights).toContain('List pros and cons');
    expect(result.next_steps).toContain('Weight criteria');
  });

  it('should handle evaluation type thinking', async () => {
    const result = await (think as any).execute({
      thought: 'How effective was our testing strategy?',
      thinking_type: 'evaluation'
    });

    expect(result.thinking_type).toBe('evaluation');
    expect(result.processed_thought).toContain('Evaluating:');
    expect(result.insights).toContain('Define success criteria');
    expect(result.next_steps).toContain('Collect evidence');
  });

  it('should handle brainstorming type thinking', async () => {
    const result = await (think as any).execute({
      thought: 'What are some creative solutions for user onboarding?',
      thinking_type: 'brainstorming'
    });

    expect(result.thinking_type).toBe('brainstorming');
    expect(result.processed_thought).toContain('Brainstorming ideas for:');
    expect(result.insights).toContain('Think divergently');
    expect(result.next_steps).toContain('Generate many ideas');
  });

  it('should handle debugging type thinking', async () => {
    const result = await (think as any).execute({
      thought: 'The API calls are failing intermittently',
      thinking_type: 'debugging'
    });

    expect(result.thinking_type).toBe('debugging');
    expect(result.processed_thought).toContain('Debugging approach for:');
    expect(result.insights).toContain('Reproduce the issue');
    expect(result.next_steps).toContain('Check assumptions');
  });

  it('should build thought chain from previous thoughts', async () => {
    const previousThoughts = [
      'First thought about the problem',
      'Second insight about the solution'
    ];

    const result = await (think as any).execute({
      thought: 'Final conclusion',
      thinking_type: 'analysis',
      previous_thoughts: previousThoughts
    });

    expect(result.thought_chain).toHaveLength(3);
    expect(result.thought_chain[0]).toBe('First thought about the problem');
    expect(result.thought_chain[1]).toBe('Second insight about the solution');
    expect(result.thought_chain[2]).toContain('Analyzing: Final conclusion');
    expect(result.metrics.chain_length).toBe(3);
  });

  it('should calculate complexity metrics', async () => {
    const longThought = 'This is a very detailed and complex thought that involves multiple concepts and requires careful consideration of various factors and implications for the overall system design and architecture.';
    
    const result = await (think as any).execute({
      thought: longThought,
      thinking_type: 'analysis',
      context: 'System design review',
      previous_thoughts: ['Prior analysis']
    });

    expect(result.metrics.word_count).toBeGreaterThan(20);
    expect(result.metrics.complexity_score).toBeGreaterThan(50);
    expect(result.metrics.chain_length).toBe(2);
  });

  it('should indicate memory saving when requested', async () => {
    const result = await (think as any).execute({
      thought: 'Important insight about user behavior',
      thinking_type: 'analysis',
      tags: ['insights', 'user-research'],
      save_to_memory: true
    });

    expect(result.memory_status).toContain('Would be saved to memory');
    expect(result.memory_tags).toEqual(['thinking', 'analysis', 'insights', 'user-research']);
  });

  it('should assign reasoning quality based on confidence', async () => {
    const highConfidence = await (think as any).execute({
      thought: 'High confidence thought',
      confidence_level: 90
    });
    expect(highConfidence.reasoning_quality).toBe('high');

    const mediumConfidence = await (think as any).execute({
      thought: 'Medium confidence thought',
      confidence_level: 65
    });
    expect(mediumConfidence.reasoning_quality).toBe('medium');

    const lowConfidence = await (think as any).execute({
      thought: 'Low confidence thought',
      confidence_level: 30
    });
    expect(lowConfidence.reasoning_quality).toBe('low');

    const unknownConfidence = await (think as any).execute({
      thought: 'No confidence specified'
    });
    expect(unknownConfidence.reasoning_quality).toBe('unknown');
  });

  it('should default to analysis thinking type', async () => {
    const result = await (think as any).execute({
      thought: 'Default thinking type test'
    });

    expect(result.thinking_type).toBe('analysis');
    expect(result.processed_thought).toContain('Analyzing:');
  });
});