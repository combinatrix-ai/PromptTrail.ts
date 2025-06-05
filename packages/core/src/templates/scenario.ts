import { CoreTool, tool } from 'ai';
import { z } from 'zod';
import type { Attrs, Vars } from '../session';
import { Session } from '../session';
import { LlmSource, Source } from '../source';
import { Agent } from './agent';
import type { Template } from './base';

/**
 * Base options for all step types
 */
interface BaseStepOptions {
  /**
   * Maximum number of assistant turns for this step
   * @default 10
   */
  max_attempts?: number;

  /**
   * Custom validation function to check if the goal is satisfied
   * If not provided, uses LLM-based goal checking
   */
  is_satisfied?: (
    session: Session<any, any>,
    goal: string,
  ) => boolean | Promise<boolean>;
}

/**
 * Options for interactive steps (with user interaction)
 */
export interface InteractiveStepOptions extends BaseStepOptions {
  /**
   * Allow the LLM to interact with the user via ask_user tool
   */
  allow_interaction: true;

  /**
   * Optional prompt template for user interaction
   * Can use ${variable} syntax for interpolation
   */
  interaction_prompt?: string;

  /**
   * Validation for user input
   */
  validate_input?: (
    input: string,
  ) => boolean | { valid: boolean; message?: string };
}

/**
 * Options for non-interactive steps (no user interaction)
 */
export interface NonInteractiveStepOptions extends BaseStepOptions {
  /**
   * No user interaction allowed
   */
  allow_interaction?: false;

  /**
   * Whether to show progress updates
   */
  show_progress?: boolean;
}

/**
 * Union type for all step options
 */
export type StepOptions = InteractiveStepOptions | NonInteractiveStepOptions;

/**
 * Helper type guards
 */
export function isInteractiveStep(
  options: StepOptions,
): options is InteractiveStepOptions {
  return options.allow_interaction === true;
}

/**
 * Configuration for the Scenario
 */
export interface ScenarioConfig {
  /**
   * Source to use for user interaction (defaults to CLI)
   */
  userInputSource?: Source<string>;

  /**
   * Additional tools available to all steps
   */
  tools?: Record<string, CoreTool>;

  /**
   * LLM source to use for all assistant steps
   * If not provided, uses Source.llm() with default configuration
   */
  llmSource?: LlmSource;
}

/**
 * Scenario class for building goal-oriented conversational flows
 *
 * The LLM drives the conversation by using tools to achieve goals
 *
 * @template TVars - The session vars type
 * @template TAttrs - The message attrs type
 *
 * @example
 * ```typescript
 * const scenario = Scenario
 *   .system('You are a research assistant')
 *   .step('Get the user\'s research topic', { allow_interaction: true })
 *   .step('Search for relevant papers and summarize findings')
 *   .step('Ask if the user needs clarification', { allow_interaction: true })
 *   .execute();
 * ```
 */
export class Scenario<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>
  implements Template<TAttrs, TVars>
{
  private systemPrompt: string;
  private steps: Array<{ goal: string; options: StepOptions }> = [];
  private config: ScenarioConfig;

  private constructor(systemPrompt: string, config: ScenarioConfig = {}) {
    this.systemPrompt = systemPrompt;
    this.config = {
      userInputSource: config.userInputSource || Source.cli(),
      tools: config.tools || {},
      llmSource: config.llmSource,
    };
  }

  /**
   * Creates a new Scenario with a system prompt
   */
  static system<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    systemPrompt: string,
    config?: ScenarioConfig,
  ): Scenario<TVars, TAttrs> {
    return new Scenario<TVars, TAttrs>(systemPrompt, config);
  }

  /**
   * Adds an interactive step where the LLM can communicate with the user
   *
   * @param goal - The goal to achieve in this step
   * @param options - Options for the interactive step
   * @returns The scenario instance for chaining
   */
  step(goal: string, options: InteractiveStepOptions): this;

  /**
   * Adds a non-interactive step where the LLM works autonomously
   *
   * @param goal - The goal to achieve in this step
   * @param options - Options for the non-interactive step
   * @returns The scenario instance for chaining
   */
  step(goal: string, options?: NonInteractiveStepOptions): this;

  /**
   * Implementation of step method
   */
  step(goal: string, options: StepOptions = {}): this {
    this.steps.push({
      goal,
      options: {
        ...options,
        allow_interaction: options.allow_interaction ?? false,
        max_attempts: options.max_attempts ?? 10,
      },
    });
    return this;
  }

  /**
   * Convenience method to add an interactive step
   */
  interact(
    goal: string,
    options?: Omit<InteractiveStepOptions, 'allow_interaction'>,
  ): this {
    return this.step(goal, {
      ...options,
      allow_interaction: true,
    });
  }

  /**
   * Convenience method to add a processing step
   */
  process(
    goal: string,
    options?: Omit<NonInteractiveStepOptions, 'allow_interaction'>,
  ): this {
    return this.step(goal, {
      ...options,
      allow_interaction: false,
    });
  }

  /**
   * Add a step that collects specific information
   */
  collect(
    fields: string | string[],
    options?: Partial<InteractiveStepOptions>,
  ): this {
    const fieldArray = Array.isArray(fields) ? fields : [fields];
    const goal = `Collect the following information from the user: ${fieldArray.join(', ')}`;

    return this.step(
      goal,
      StepTemplates.collectInfo(fieldArray, {
        maxAttempts: options?.max_attempts,
      }),
    );
  }

  /**
   * Add a decision point step
   */
  decide(
    decision: string,
    options?: {
      branches?: Record<string, string>;
      maxAttempts?: number;
    },
  ): this {
    const branchInfo = options?.branches
      ? ` Consider these options: ${Object.entries(options.branches)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')}`
      : '';

    return this.step(
      `Make a decision: ${decision}${branchInfo}`,
      StepTemplates.process({ maxAttempts: options?.maxAttempts }),
    );
  }

  /**
   * Compiles the scenario into an Agent-based implementation
   */
  private compile(): Agent<TVars, TAttrs> {
    const agent = Agent.create<TVars, TAttrs>();

    for (const [index, step] of this.steps.entries()) {
      // Each step is a subroutine that loops until the goal is satisfied
      agent.subroutine(
        (subAgent, parentSession) => {
          // Only add system message for the first step when retaining messages
          // For subsequent steps, the system context is preserved from the retained messages
          if (index === 0) {
            const interactiveInstruction = step.options.allow_interaction
              ? '\n\nIMPORTANT: This is an INTERACTIVE step. You MUST use the ask_user tool to get user input. Do not use other tools unless the user provides information first.'
              : '';

            subAgent.system(
              `${this.systemPrompt}\n\n` +
                `Current Task: ${step.goal}\n` +
                `You must accomplish this task. Use the available tools as needed.` +
                interactiveInstruction,
            );
          } else {
            // For subsequent steps, add a user message with the current task instead of a system message
            // This preserves the conversation flow without violating ai-sdk message ordering rules
            const interactiveInstruction = step.options.allow_interaction
              ? ' This is an INTERACTIVE step - you MUST use the ask_user tool to get user input first.'
              : '';

            subAgent.user(
              `New Task: ${step.goal}. You must accomplish this task using the available tools.${interactiveInstruction}\n\nContext: You have access to the previous conversation history above. Use any relevant information from previous steps to accomplish this task.`,
            );
          }

          // Create the loop that runs until goal is satisfied or max attempts reached
          let attempts = 0;

          // Create a reference to track the current session state
          let currentSession: Session<any, any> = parentSession;

          return subAgent.loop(
            (loopAgent) => {
              // Build the tools for this step
              const tools: Record<string, CoreTool> = {};

              // For interactive steps, only provide ask_user and check_goal initially
              if (step.options.allow_interaction) {
                tools.ask_user = this.createAskUserTool(step.options);
                tools.check_goal = this.createCheckGoalTool(
                  step.goal,
                  step.options.is_satisfied,
                  () => currentSession,
                );
              } else {
                // For non-interactive steps, provide all tools
                Object.assign(tools, this.config.tools);
                tools.check_goal = this.createCheckGoalTool(
                  step.goal,
                  step.options.is_satisfied,
                  () => currentSession,
                );
              }

              // Assistant turn with available tools
              let llmSource = this.config.llmSource;
              if (!llmSource) {
                llmSource = Source.llm();
              }

              // Add each tool individually
              for (const [name, tool] of Object.entries(tools)) {
                llmSource = llmSource.withTool(name, tool);
              }

              return loopAgent.assistant(llmSource);
            },
            // Continue loop while goal not satisfied and under attempt limit
            (session) => {
              // Update the current session reference for tool access
              currentSession = session;

              // Only increment attempts after the first assistant message
              const hasAssistantMessage =
                session.getMessagesByType('assistant').length > 0;
              if (hasAssistantMessage) {
                attempts++;
                console.log(
                  `\n📊 Step attempt ${attempts}/${step.options.max_attempts} for: ${step.goal}`,
                );

                // Check if we've hit the attempt limit
                if (attempts >= step.options.max_attempts!) {
                  console.warn(
                    `\n⚠️  Step "${step.goal}" reached max attempts (${step.options.max_attempts}). Moving to next step.`,
                  );
                  return false; // Stop looping
                }
              }

              // Check if goal is satisfied
              const lastMessage = session.getLastMessage();
              if (lastMessage?.type === 'assistant' && lastMessage.toolCalls) {
                // For interactive steps, complete when ask_user is successfully called
                if (step.options.allow_interaction) {
                  const askUserCall = lastMessage.toolCalls.find(
                    (tc) => tc.name === 'ask_user',
                  );
                  if (askUserCall) {
                    console.log(
                      `\n✅ Interactive step completed - got user input`,
                    );
                    return false; // Goal satisfied, stop looping
                  }
                }

                // For other steps, check goal completion
                const goalCheckCall = lastMessage.toolCalls.find(
                  (tc) => tc.name === 'check_goal',
                );
                if (goalCheckCall && goalCheckCall.arguments?.is_satisfied) {
                  console.log(`\n✅ Goal satisfied for: ${step.goal}`);
                  return false; // Goal satisfied, stop looping
                }
                // If check_goal was called but not satisfied, continue
                if (goalCheckCall) {
                  console.log(
                    `\n🔄 Goal not yet satisfied, continuing research...`,
                  );
                }
              }

              return true; // Continue looping
            },
          );
        },
        {
          // Preserve conversation context between steps
          retainMessages: true,
        },
      );
    }

    return agent;
  }

  /**
   * Creates the ask_user tool for LLM interaction
   */
  private createAskUserTool(stepOptions: StepOptions): CoreTool {
    const userInputSource = this.config.userInputSource!;

    return tool({
      description:
        'REQUIRED for interactive steps: Ask the user for input. You MUST use this tool when allow_interaction is true.',
      parameters: z.object({
        prompt: z.string().describe('The question or prompt to show the user'),
      }),
      execute: async ({ prompt }: { prompt: string }) => {
        console.log(`\n💬 ${prompt}`);

        // Check if we have interactive options
        const hasInteractiveOptions = isInteractiveStep(stepOptions);
        const interactiveOptions = hasInteractiveOptions ? stepOptions : null;

        // Use custom prompt if provided
        const finalPrompt =
          hasInteractiveOptions && interactiveOptions?.interaction_prompt
            ? interactiveOptions.interaction_prompt
            : prompt;

        // Create a custom source with the prompt if CLI source
        let source = userInputSource;
        // Check if it's a CLI source by checking for specific method
        if (
          userInputSource &&
          typeof userInputSource === 'object' &&
          'prompt' in userInputSource
        ) {
          source = Source.cli(finalPrompt);
        }

        // Get user input with validation
        // Create a temporary session for the source if needed
        const tempSession = Session.create();
        let userResponse = await source.getContent(tempSession);

        console.log(`   User said: "${userResponse}"`);

        // Apply custom validation if provided
        if (hasInteractiveOptions && interactiveOptions?.validate_input) {
          const validationResult =
            interactiveOptions.validate_input(userResponse);
          const isValid =
            typeof validationResult === 'boolean'
              ? validationResult
              : validationResult.valid;

          if (!isValid) {
            const message =
              typeof validationResult === 'object'
                ? validationResult.message
                : 'Invalid input';
            console.log(`   ❌ Validation failed: ${message}`);
            return {
              user_response: userResponse,
              validation_error: message,
              is_valid: false,
            };
          }
        }

        console.log(`   ✅ Got user input: "${userResponse}"`);

        // Return the user response and also log it to make it visible in conversation history
        // This ensures the user's question is preserved for subsequent steps
        console.log(
          `\n📝 IMPORTANT: User's question for next steps: "${userResponse}"`,
        );

        return {
          success: true,
          user_question: userResponse,
          message: `User asked: "${userResponse}"`,
          // Adding this to ensure it gets into the conversation context
          note: `Remember: The user's question is "${userResponse}" - use this for research in subsequent steps.`,
        };
      },
    });
  }

  /**
   * Creates the check_goal tool for goal validation
   */
  private createCheckGoalTool(
    goal: string,
    customValidator?: (
      session: Session<any, any>,
      goal: string,
    ) => boolean | Promise<boolean>,
    getSession?: () => Session<any, any>,
  ): CoreTool {
    return tool({
      description: `REQUIRED: Check if you have satisfied the goal: "${goal}". You MUST call this tool after gathering information to evaluate your progress.`,
      parameters: z.object({
        reasoning: z
          .string()
          .describe(
            'Explain why you believe the goal is or is not satisfied based on the information you have gathered',
          ),
        is_satisfied: z
          .boolean()
          .describe(
            'Whether the goal has been achieved - true if you have enough information to answer comprehensively, false if you need more research',
          ),
      }),
      execute: async ({
        reasoning,
        is_satisfied,
      }: {
        reasoning: string;
        is_satisfied: boolean;
      }) => {
        console.log(`\n🎯 Goal Check: ${is_satisfied ? '✅' : '❌'}`);
        console.log(`   Reasoning: ${reasoning}`);

        // If custom validator provided, use it
        if (customValidator && getSession) {
          const currentSession = getSession();
          const customResult = await customValidator(currentSession, goal);
          return {
            is_satisfied: customResult,
            reasoning: customResult
              ? 'Goal satisfied per custom validator'
              : 'Goal not satisfied per custom validator',
          };
        }

        // Otherwise, trust the LLM's judgment
        return {
          is_satisfied,
          reasoning,
        };
      },
    });
  }

  /**
   * Executes the scenario
   */
  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const compiledAgent = this.compile();
    return compiledAgent.execute(session);
  }
}

/**
 * Predefined step option templates for common patterns
 */
export const StepTemplates = {
  /**
   * Ask the user for input with optional validation
   */
  askUser(options?: {
    prompt?: string;
    validate?: (
      input: string,
    ) => boolean | { valid: boolean; message?: string };
    maxAttempts?: number;
  }): InteractiveStepOptions {
    return {
      allow_interaction: true,
      interaction_prompt: options?.prompt,
      validate_input: options?.validate,
      max_attempts: options?.maxAttempts ?? 10,
    };
  },

  /**
   * Process data without user interaction
   */
  process(options?: {
    maxAttempts?: number;
    showProgress?: boolean;
  }): NonInteractiveStepOptions {
    return {
      allow_interaction: false,
      max_attempts: options?.maxAttempts ?? 10,
      show_progress: options?.showProgress ?? false,
    };
  },

  /**
   * Loop until a condition is met
   */
  untilCondition(
    condition: (session: Session<any, any>) => boolean | Promise<boolean>,
    options?: {
      maxAttempts?: number;
    },
  ): NonInteractiveStepOptions {
    return {
      allow_interaction: false,
      max_attempts: options?.maxAttempts ?? 20,
      is_satisfied: async (session, goal) => await condition(session),
    };
  },

  /**
   * Collect multiple pieces of information from the user
   */
  collectInfo(
    fields: string[],
    options?: {
      maxAttempts?: number;
    },
  ): InteractiveStepOptions {
    return {
      allow_interaction: true,
      max_attempts: options?.maxAttempts ?? 15,
      is_satisfied: (session) => {
        // Check if all fields have been collected
        const content = session.messages.map((m) => m.content).join(' ');
        return fields.every((field) =>
          content.toLowerCase().includes(field.toLowerCase()),
        );
      },
    };
  },

  /**
   * Quick task with minimal retries
   */
  quick(options?: { maxAttempts?: number }): NonInteractiveStepOptions {
    return {
      allow_interaction: false,
      max_attempts: options?.maxAttempts ?? 3,
    };
  },
} as const;

/**
 * Factory function for common scenarios
 */
export namespace Scenarios {
  /**
   * Creates a research assistant scenario
   */
  export function researchAssistant(config?: ScenarioConfig) {
    return Scenario.system(
      'You are a research assistant. Help users find and understand information.',
      config,
    )
      .step('Ask the user what they want to research', StepTemplates.askUser())
      .step(
        'Search for relevant information and compile findings',
        StepTemplates.process(),
      )
      .step(
        'Present a summary and ask if they need clarification',
        StepTemplates.askUser({
          prompt: 'Do you need any clarification on the findings?',
        }),
      )
      .step(
        'Answer any follow-up questions',
        StepTemplates.askUser({ maxAttempts: 5 }),
      );
  }

  /**
   * Creates a code review scenario
   */
  export function codeReviewer(config?: ScenarioConfig) {
    return Scenario.system(
      'You are a code reviewer. Analyze code and provide constructive feedback.',
      config,
    )
      .step(
        'Ask for the code to review',
        StepTemplates.askUser({
          prompt: "Please provide the code you'd like me to review.",
        }),
      )
      .step(
        'Analyze the code for issues, patterns, and improvements',
        StepTemplates.process({
          showProgress: true,
        }),
      )
      .step('Provide detailed feedback with examples', StepTemplates.quick())
      .step('Discuss any questions about the review', StepTemplates.askUser());
  }

  /**
   * Creates a data collection scenario
   */
  export function dataCollector(fields: string[], config?: ScenarioConfig) {
    return Scenario.system(
      'You are a helpful assistant collecting information from the user.',
      config,
    )
      .step(
        `Collect the following information: ${fields.join(', ')}`,
        StepTemplates.collectInfo(fields),
      )
      .step(
        'Confirm all information is correct',
        StepTemplates.askUser({
          validate: (input) => {
            const lower = input.toLowerCase();
            return (
              lower.includes('yes') ||
              lower.includes('correct') ||
              lower.includes('confirm')
            );
          },
        }),
      );
  }
}
