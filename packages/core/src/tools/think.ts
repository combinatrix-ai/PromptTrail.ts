import { Tool } from '../tool';
import { z } from 'zod';

/**
 * Think tool for internal reasoning and reflection
 * Allows LLMs to process thoughts before providing responses
 * Useful for complex problem-solving and decision-making
 */
export const think = Tool.create({
  description: 'Internal reasoning tool for processing thoughts, analyzing problems, and planning responses before acting',
  parameters: z.object({
    thought: z.string().describe('The internal thought, analysis, or reasoning to process'),
    thinking_type: z
      .enum([
        'analysis',
        'planning', 
        'reflection',
        'problem_solving',
        'decision_making',
        'evaluation',
        'brainstorming',
        'debugging'
      ])
      .optional()
      .default('analysis')
      .describe('Type of thinking being performed'),
    context: z
      .string()
      .optional()
      .describe('Additional context for the thinking process'),
    previous_thoughts: z
      .array(z.string())
      .optional()
      .describe('Chain of previous thoughts to build upon'),
    confidence_level: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Confidence level in this thought (0-100)'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Tags to categorize this thought'),
    save_to_memory: z
      .boolean()
      .optional()
      .default(false)
      .describe('Whether to save this thought to persistent memory for future reference'),
  }),
  execute: async ({ 
    thought,
    thinking_type = 'analysis',
    context,
    previous_thoughts,
    confidence_level,
    tags,
    save_to_memory = false
  }) => {
    const timestamp = new Date().toISOString();
    const thinking_id = `think_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Process the thought based on type
    let processed_thought = '';
    const next_steps: string[] = [];
    const insights: string[] = [];

    switch (thinking_type) {
      case 'analysis':
        processed_thought = `Analyzing: ${thought}`;
        if (context) {
          processed_thought += `\nContext: ${context}`;
        }
        insights.push('Consider multiple perspectives', 'Look for patterns and connections');
        next_steps.push('Identify key components', 'Evaluate evidence', 'Draw conclusions');
        break;

      case 'planning':
        processed_thought = `Planning approach for: ${thought}`;
        insights.push('Break down into steps', 'Consider dependencies', 'Identify resources needed');
        next_steps.push('Define objectives', 'Create timeline', 'Assign priorities');
        break;

      case 'reflection':
        processed_thought = `Reflecting on: ${thought}`;
        insights.push('What worked well?', 'What could be improved?', 'What was learned?');
        next_steps.push('Document lessons learned', 'Apply insights to future situations');
        break;

      case 'problem_solving':
        processed_thought = `Problem-solving for: ${thought}`;
        insights.push('Define the problem clearly', 'Generate multiple solutions', 'Evaluate trade-offs');
        next_steps.push('Identify root cause', 'Brainstorm solutions', 'Test hypotheses');
        break;

      case 'decision_making':
        processed_thought = `Decision analysis: ${thought}`;
        insights.push('List pros and cons', 'Consider long-term implications', 'Assess risks');
        next_steps.push('Gather more information if needed', 'Weight criteria', 'Make decision');
        break;

      case 'evaluation':
        processed_thought = `Evaluating: ${thought}`;
        insights.push('Define success criteria', 'Measure against standards', 'Consider context');
        next_steps.push('Collect evidence', 'Apply criteria', 'Document findings');
        break;

      case 'brainstorming':
        processed_thought = `Brainstorming ideas for: ${thought}`;
        insights.push('Think divergently', 'Build on others\' ideas', 'Suspend judgment');
        next_steps.push('Generate many ideas', 'Combine concepts', 'Refine promising options');
        break;

      case 'debugging':
        processed_thought = `Debugging approach for: ${thought}`;
        insights.push('Reproduce the issue', 'Isolate variables', 'Test systematically');
        next_steps.push('Check assumptions', 'Trace execution', 'Verify fixes');
        break;

      default:
        processed_thought = thought;
    }

    // Build thought chain if previous thoughts provided
    let thought_chain: string[] = [];
    if (previous_thoughts && previous_thoughts.length > 0) {
      thought_chain = [...previous_thoughts, processed_thought];
    } else {
      thought_chain = [processed_thought];
    }

    // Calculate thinking metrics
    const word_count = thought.split(/\s+/).length;
    const complexity_score = Math.min(100, word_count * 2 + (context ? 20 : 0) + (previous_thoughts?.length || 0) * 10);

    const result = {
      thinking_id,
      timestamp,
      thinking_type,
      original_thought: thought,
      processed_thought,
      context,
      thought_chain,
      insights,
      next_steps,
      confidence_level,
      tags,
      metrics: {
        word_count,
        complexity_score,
        chain_length: thought_chain.length,
      },
      reasoning_quality: confidence_level 
        ? confidence_level > 80 ? 'high' : confidence_level > 50 ? 'medium' : 'low'
        : 'unknown',
    };

    // If requested, save to memory (would need to integrate with memory system)
    if (save_to_memory) {
      // In a real implementation, this would call the memory-write tool
      // For now, we just indicate that it would be saved
      return {
        ...result,
        memory_status: 'Would be saved to memory with category "internal_thoughts"',
        memory_tags: ['thinking', thinking_type, ...(tags || [])],
      };
    }

    return result;
  },
});