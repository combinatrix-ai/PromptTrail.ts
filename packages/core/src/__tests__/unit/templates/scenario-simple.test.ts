import { describe, it, expect } from 'vitest';
import { Scenario } from '../../../templates/scenario';

describe('Scenario Basic Tests', () => {
  it('should create a scenario', () => {
    const scenario = Scenario.system('Test assistant');
    expect(scenario).toBeDefined();
    expect(scenario.step).toBeDefined();
    expect(scenario.execute).toBeDefined();
  });

  it('should add steps', () => {
    const scenario = Scenario.system('Test')
      .step('Step 1')
      .step('Step 2', { max_attempts: 5 })
      .step('Step 3', { allow_interaction: true });

    expect(scenario).toBeDefined();
  });

  it('should support convenience methods', () => {
    const scenario = Scenario.system('Test')
      .interact('Get user input')
      .process('Process data')
      .collect(['name', 'email'])
      .decide('Choose option');

    expect(scenario).toBeDefined();
  });
});
