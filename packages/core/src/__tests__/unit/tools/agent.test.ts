import { describe, it, expect } from 'vitest';
import { agent } from '../../../tools/agent';

describe('agent', () => {
  it('should create and execute sync task', async () => {
    const result = await (agent as any).execute({
      task_description: 'Analyze user feedback and suggest improvements',
      agent_type: 'analyst',
      execution_mode: 'sync'
    });

    expect(result.task_id).toBeDefined();
    expect(result.status).toBe('completed');
    expect(result.agent_type).toBe('analyst');
    expect(result.execution_mode).toBe('sync');
    expect(result.task.status).toBe('completed');
    expect(result.result).toBeDefined();
    expect(result.result.analysis).toContain('Analysis completed');
  });

  it('should handle different agent types', async () => {
    const researcherResult = await (agent as any).execute({
      task_description: 'Find information about TypeScript best practices',
      agent_type: 'researcher',
      execution_mode: 'sync'
    });

    expect(researcherResult.agent_type).toBe('researcher');
    expect(researcherResult.result.findings).toBeDefined();
    expect(researcherResult.capabilities_used).toContain('web_search');

    const coderResult = await (agent as any).execute({
      task_description: 'Implement user authentication',
      agent_type: 'coder',
      execution_mode: 'sync'
    });

    expect(coderResult.agent_type).toBe('coder');
    expect(coderResult.result.code_changes).toBeDefined();
    expect(coderResult.capabilities_used).toContain('file_edit');
  });

  it('should handle async execution mode', async () => {
    const result = await (agent as any).execute({
      task_description: 'Long running data analysis',
      agent_type: 'analyst',
      execution_mode: 'async',
      max_execution_time: 600
    });

    expect(result.status).toBe('in_progress');
    expect(result.execution_mode).toBe('async');
    expect(result.estimated_completion).toBeDefined();
    expect(result.tracking_info).toBeDefined();
    expect(result.tracking_info.check_status_with).toBe('agent_status_check_tool');
  });

  it('should handle background execution mode', async () => {
    const result = await (agent as any).execute({
      task_description: 'Monitor system performance',
      agent_type: 'optimizer',
      execution_mode: 'background'
    });

    expect(result.status).toBe('dispatched');
    expect(result.execution_mode).toBe('background');
    expect(result.message).toContain('dispatched to background');
    expect(result.estimated_completion).toBeDefined();
  });

  it('should set task priority', async () => {
    const result = await (agent as any).execute({
      task_description: 'Critical bug fix',
      agent_type: 'debugger',
      task_priority: 'urgent',
      execution_mode: 'sync'
    });

    expect(result.execution_summary.priority).toBe('urgent');
  });

  it('should handle context and tools', async () => {
    const context = {
      project: 'PromptTrail.ts',
      language: 'TypeScript',
      deadline: '2024-01-15'
    };

    const tools = ['file_read', 'file_edit', 'bash'];

    const result = await (agent as any).execute({
      task_description: 'Refactor authentication module',
      agent_type: 'coder',
      context,
      tools_required: tools,
      execution_mode: 'sync'
    });

    expect(result.tools_used).toEqual(tools);
  });

  it('should handle dependencies and parent tasks', async () => {
    const result = await (agent as any).execute({
      task_description: 'Integration testing',
      agent_type: 'tester',
      dependencies: ['task_123', 'task_456'],
      parent_task_id: 'parent_789',
      execution_mode: 'sync'
    });

    expect(result.dependencies_resolved).toEqual(['task_123', 'task_456']);
    expect(result.parent_task_id).toBe('parent_789');
  });

  it('should provide appropriate capabilities for each agent type', async () => {
    const agentTypes = [
      'researcher',
      'coder',
      'analyst',
      'writer',
      'debugger',
      'tester',
      'reviewer',
      'planner',
      'optimizer',
      'general'
    ];

    for (const agentType of agentTypes) {
      const result = await (agent as any).execute({
        task_description: `Test task for ${agentType}`,
        agent_type: agentType as any,
        execution_mode: 'sync'
      });

      expect(result.capabilities_used).toBeDefined();
      expect(Array.isArray(result.capabilities_used)).toBe(true);
      expect(result.capabilities_used.length).toBeGreaterThan(0);
    }
  });

  it('should generate unique task IDs', async () => {
    const results = await Promise.all([
      (agent as any).execute({
        task_description: 'Task 1',
        execution_mode: 'sync'
      }),
      (agent as any).execute({
        task_description: 'Task 2',
        execution_mode: 'sync'
      }),
      (agent as any).execute({
        task_description: 'Task 3',
        execution_mode: 'sync'
      })
    ]);

    const taskIds = results.map(r => r.task_id);
    const uniqueIds = new Set(taskIds);
    expect(uniqueIds.size).toBe(3);
  });

  it('should respect max execution time', async () => {
    const result = await (agent as any).execute({
      task_description: 'Time-constrained task',
      agent_type: 'general',
      max_execution_time: 120,
      execution_mode: 'async'
    });

    const estimatedTime = new Date(result.estimated_completion).getTime();
    const currentTime = Date.now();
    const timeDiff = estimatedTime - currentTime;
    
    expect(timeDiff).toBeLessThanOrEqual(120 * 1000); // 120 seconds in milliseconds
  });

  it('should default to general agent and medium priority', async () => {
    const result = await (agent as any).execute({
      task_description: 'Default settings test',
      execution_mode: 'sync'
    });

    expect(result.agent_type).toBe('general');
    expect(result.execution_summary.priority).toBe('medium');
  });

  it('should generate task execution summary', async () => {
    const result = await (agent as any).execute({
      task_description: 'Test task execution summary',
      agent_type: 'general',
      task_priority: 'high',
      execution_mode: 'sync'
    });

    expect(result.execution_summary).toBeDefined();
    expect(result.execution_summary.started_at).toBeDefined();
    expect(result.execution_summary.completed_at).toBeDefined();
    expect(result.execution_summary.execution_time_ms).toBeGreaterThan(0);
    expect(result.execution_summary.priority).toBe('high');
  });

  it('should provide specialized results for different agent types', async () => {
    // Test researcher result structure
    const researchResult = await (agent as any).execute({
      task_description: 'Research task',
      agent_type: 'researcher',
      execution_mode: 'sync'
    });
    expect(researchResult.result.findings).toBeDefined();
    expect(researchResult.result.sources_found).toBeGreaterThan(0);
    expect(researchResult.result.confidence).toBeGreaterThan(0);

    // Test coder result structure
    const codeResult = await (agent as any).execute({
      task_description: 'Coding task',
      agent_type: 'coder',
      execution_mode: 'sync'
    });
    expect(codeResult.result.code_changes).toBeDefined();
    expect(codeResult.result.files_modified).toBeGreaterThan(0);
    expect(codeResult.result.tests_passed).toBe(true);

    // Test analyst result structure
    const analysisResult = await (agent as any).execute({
      task_description: 'Analysis task',
      agent_type: 'analyst',
      execution_mode: 'sync'
    });
    expect(analysisResult.result.analysis).toBeDefined();
    expect(analysisResult.result.patterns_found).toBeGreaterThan(0);
    expect(Array.isArray(analysisResult.result.recommendations)).toBe(true);
  });
});