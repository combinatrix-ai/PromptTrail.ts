import type { Attrs, Session, Vars } from '../../session';
import { LlmSource, Source } from '../../source';
import { TemplateBase } from '../base';
import { LLMConfig } from './assistant';

/**
 * Type for scoring function that evaluates a session
 */
export type ScoringFunction<TVars extends Vars, TAttrs extends Attrs> = (
  session: Session<TVars, TAttrs>,
) => number;

/**
 * Type for aggregation strategy function
 */
export type AggregationStrategy<TVars extends Vars, TAttrs extends Attrs> = (
  sessions: Session<TVars, TAttrs>[],
) => Session<TVars, TAttrs>;

/**
 * Built-in aggregation strategies
 */
export type BuiltInStrategy = 'keep_all' | 'best';

/**
 * Union type for all possible strategies
 */
export type Strategy<TVars extends Vars, TAttrs extends Attrs> =
  | BuiltInStrategy
  | AggregationStrategy<TVars, TAttrs>;

/**
 * Configuration for a parallel source execution
 */
interface ParallelSourceConfig {
  source: LlmSource;
  repetitions: number;
}

/**
 * Input type for parallel sources - can be either direct LLM config or Source
 */
export type ParallelSourceInput = LLMConfig | LlmSource;

/**
 * Configuration object for creating Parallel templates
 */
export interface ParallelConfig<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  sources?: Array<{ source: ParallelSourceInput; repetitions?: number }>;
  scoringFunction?: ScoringFunction<TVars, TAttrs>;
  strategy?: Strategy<TVars, TAttrs>;
}

/**
 * Builder class for creating Parallel configurations
 */
export class ParallelBuilder<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> {
  private sources: Array<{
    source: ParallelSourceInput;
    repetitions?: number;
  }> = [];
  private scoringFunction?: ScoringFunction<TVars, TAttrs>;
  private strategy: Strategy<TVars, TAttrs> = 'keep_all';

  withSource(source: ParallelSourceInput, repetitions: number = 1): this {
    this.sources.push({ source, repetitions });
    return this;
  }

  withSources(
    sources: Array<{ source: ParallelSourceInput; repetitions?: number }>,
  ): this {
    this.sources = [...sources];
    return this;
  }

  withAggregationFunction(
    scoringFunction: ScoringFunction<TVars, TAttrs>,
  ): this {
    this.scoringFunction = scoringFunction;
    return this;
  }

  withStrategy(strategy: Strategy<TVars, TAttrs>): this {
    this.strategy = strategy;
    return this;
  }

  build(): ParallelConfig<TVars, TAttrs> {
    return {
      sources: this.sources.map((s) => ({
        source: this.createLlmSource(s.source),
        repetitions: s.repetitions || 1,
      })),
      scoringFunction: this.scoringFunction,
      strategy: this.strategy,
    };
  }

  /**
   * Convert ParallelSourceInput to LlmSource for internal use
   * @private
   */
  private createLlmSource(source: ParallelSourceInput): LlmSource {
    if (typeof source === 'object' && 'getContent' in source) {
      // Already an LlmSource
      return source as LlmSource;
    } else {
      // It's an LLMConfig, convert to Source
      const config = source as LLMConfig;
      let llmSource = Source.llm();

      // Apply provider configuration
      switch (config.provider) {
        case 'openai':
          llmSource = llmSource.openai({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            modelName: config.model || 'gpt-4o-mini',
            dangerouslyAllowBrowser: config.dangerouslyAllowBrowser,
          });
          break;
        case 'anthropic':
          llmSource = llmSource.anthropic({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            modelName: config.model || 'claude-3-5-haiku-latest',
          });
          break;
        case 'google':
          llmSource = llmSource.google({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            modelName: config.model || 'gemini-pro',
          });
          break;
      }

      // Apply generation parameters
      if (config.temperature !== undefined) {
        llmSource = llmSource.temperature(config.temperature);
      }
      if (config.maxTokens !== undefined) {
        llmSource = llmSource.maxTokens(config.maxTokens);
      }
      if (config.topP !== undefined) {
        llmSource = llmSource.topP(config.topP);
      }
      if (config.topK !== undefined) {
        llmSource = llmSource.topK(config.topK);
      }
      if (config.tools !== undefined) {
        llmSource = llmSource.withTools(config.tools);
      }
      if (config.toolChoice !== undefined) {
        llmSource = llmSource.toolChoice(config.toolChoice);
      }
      if (config.schema !== undefined) {
        llmSource = llmSource.withSchema(config.schema, {
          mode: config.mode,
          functionName: config.functionName,
        });
      }

      return llmSource;
    }
  }
}

/**
 * A template that executes multiple LLM sources in parallel and aggregates results.
 *
 * @template TAttrs - Type of the session metadata.
 * @template TVars - Type of the session context.
 *
 * @example
 * ```typescript
 * // Simple parallel execution with generation configs
 * const agent = Agent.create()
 *   .system('You are an assistant')
 *   .user('Question?')
 *   .parallel(p => p
 *     .withSource({ provider: 'openai', temperature: 0.2 }, 2)
 *     .withSource({ provider: 'anthropic', temperature: 0.8 })
 *     .withStrategy('best')
 *   );
 *
 * // Advanced configuration
 * const agent = Agent.create()
 *   .system('You are an assistant')
 *   .user('Question?')
 *   .parallel(p => p
 *     .withSource({
 *       provider: 'openai',
 *       model: 'gpt-4',
 *       temperature: 0.1,
 *       maxTokens: 1000
 *     }, 3)
 *     .withSource({ provider: 'anthropic', model: 'claude-3-5-haiku-latest' })
 *     .withAggregationFunction(session => session.messages.length)
 *     .withStrategy('best')
 *   );
 *
 * // Still supports Source objects for advanced use cases
 * const agent = Agent.create()
 *   .system('You are an assistant')
 *   .user('Question?')
 *   .parallel(p => p
 *     .withSource(Source.llm().openai().temperature(0.2), 2)
 *     .withSource(Source.llm().anthropic().temperature(0.8))
 *     .withStrategy('best')
 *   );
 * ```
 *
 * @remarks
 * When using the 'best' strategy without a custom scoring function,
 * the template automatically generates a LangChain-style evaluation
 * prompt that considers relevance, accuracy, completeness, clarity,
 * and helpfulness of the responses.
 *
 * @public
 */
export class Parallel<
  TAttrs extends Attrs = Record<string, any>,
  TVars extends Vars = Record<string, any>,
> extends TemplateBase<TAttrs, TVars> {
  private sources: ParallelSourceConfig[] = [];
  private scoringFunction?: ScoringFunction<TVars, TAttrs>;
  private strategy: Strategy<TVars, TAttrs> = 'keep_all';

  /**
   * Creates a new Parallel template.
   *
   * @param options - Configuration options for parallel execution
   */
  constructor(options?: {
    sources?: Array<{ source: ParallelSourceInput; repetitions?: number }>;
    scoringFunction?: ScoringFunction<TVars, TAttrs>;
    strategy?: Strategy<TVars, TAttrs>;
  }) {
    super();

    if (options?.sources) {
      this.sources = options.sources.map((s) => ({
        source: this.createLlmSource(s.source),
        repetitions: s.repetitions ?? 1,
      }));
    }

    if (options?.scoringFunction) {
      this.scoringFunction = options.scoringFunction;
    }

    if (options?.strategy) {
      this.strategy = options.strategy;
    }
  }

  /**
   * Get the current list of configured sources.
   *
   * @returns Array of source configurations
   */
  getSources(): Array<{ source: LlmSource; repetitions: number }> {
    return [...this.sources];
  }

  /**
   * Get the current scoring function.
   *
   * @returns The scoring function or undefined if not set
   */
  getScoringFunction(): ScoringFunction<TVars, TAttrs> | undefined {
    return this.scoringFunction;
  }

  /**
   * Get the current aggregation strategy.
   *
   * @returns The current strategy
   */
  getStrategy(): Strategy<TVars, TAttrs> {
    return this.strategy;
  }

  /**
   * Execute all sources in parallel and aggregate the results.
   *
   * @param session - The session to execute with
   * @returns Promise resolving to the aggregated session
   */
  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const currentSession = this.ensureSession(session);

    if (this.sources.length === 0) {
      return currentSession;
    }

    // Create execution tasks for all sources with their repetitions
    const executionTasks: Promise<Session<TVars, TAttrs>>[] = [];

    for (const config of this.sources) {
      for (let i = 0; i < config.repetitions; i++) {
        const task = this.executeSource(config.source, currentSession);
        executionTasks.push(task);
      }
    }

    // Execute all tasks in parallel
    const results = await Promise.all(executionTasks);

    // Apply aggregation strategy
    return await this.aggregateResults(results, currentSession);
  }

  /**
   * Execute a single source with the given session.
   *
   * @private
   */
  private async executeSource(
    source: LlmSource,
    session: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    try {
      const content = await source.getContent(session);

      // Add the LLM response as an assistant message
      return session.addMessage({
        type: 'assistant',
        content: content.content,
        attrs: content.metadata as TAttrs,
      });
    } catch (error) {
      console.warn(`Parallel source execution failed:`, error);
      // Return the original session on failure
      return session;
    }
  }

  /**
   * Aggregate multiple session results according to the configured strategy.
   *
   * @private
   */
  private async aggregateResults(
    results: Session<TVars, TAttrs>[],
    originalSession: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    if (results.length === 0) {
      return originalSession;
    }

    if (typeof this.strategy === 'function') {
      // Custom aggregation function
      return this.strategy(results);
    }

    switch (this.strategy) {
      case 'keep_all':
        return this.aggregateKeepAll(results, originalSession);

      case 'best':
        return await this.aggregateBest(results, originalSession);

      default:
        throw new Error(`Unknown aggregation strategy: ${this.strategy}`);
    }
  }

  /**
   * Aggregate by keeping all results (combining all messages).
   *
   * @private
   */
  private aggregateKeepAll(
    results: Session<TVars, TAttrs>[],
    originalSession: Session<TVars, TAttrs>,
  ): Session<TVars, TAttrs> {
    let aggregatedSession = originalSession;

    for (const result of results) {
      // Get only the new messages (those added by the source execution)
      const newMessages = result.messages.slice(
        originalSession.messages.length,
      );

      for (const message of newMessages) {
        aggregatedSession = aggregatedSession.addMessage(message);
      }
    }

    return aggregatedSession;
  }

  /**
   * Aggregate by keeping only the best result according to the scoring function.
   *
   * @private
   */
  private async aggregateBest(
    results: Session<TVars, TAttrs>[],
    originalSession: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    if (!this.scoringFunction) {
      // Use default LangChain-style scoring function
      return await this.aggregateBestWithDefaultScoring(
        results,
        originalSession,
      );
    }

    let bestSession = results[0];
    let bestScore = this.scoringFunction(bestSession);

    for (let i = 1; i < results.length; i++) {
      const currentScore = this.scoringFunction(results[i]);
      if (currentScore > bestScore) {
        bestScore = currentScore;
        bestSession = results[i];
      }
    }

    return bestSession;
  }

  /**
   * Default scoring using LangChain-style meta-evaluation prompt.
   * Creates a prompt that asks an LLM to evaluate and rank the responses.
   *
   * @private
   */
  private async aggregateBestWithDefaultScoring(
    results: Session<TVars, TAttrs>[],
    originalSession: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    if (results.length === 0) {
      return originalSession;
    }

    if (results.length === 1) {
      return results[0];
    }

    // Extract the responses from each result session
    const responses = results.map((session, index) => {
      const newMessages = session.messages.slice(
        originalSession.messages.length,
      );
      const response = newMessages
        .filter((msg) => msg.type === 'assistant')
        .map((msg) => msg.content)
        .join('\n');
      return { index, response };
    });

    // Create a LangChain-style evaluation prompt
    const evaluationPrompt = this.createEvaluationPrompt(
      originalSession,
      responses,
    );

    // TODO: In a full implementation, this would call an LLM with the evaluation prompt
    // to get a proper ranking. For now, we use a heuristic based on response quality metrics.
    // The evaluation prompt is generated in LangChain style for future LLM integration.

    // Heuristic scoring: considers length, vocabulary diversity, and structure
    let bestIndex = 0;
    let bestScore = 0;

    for (const { index, response } of responses) {
      // Calculate various quality metrics
      const words = response.toLowerCase().split(/\s+/);
      const uniqueWords = new Set(words);
      const sentences = response
        .split(/[.!?]+/)
        .filter((s) => s.trim().length > 0);

      // Score based on: length, vocabulary diversity, sentence structure
      const lengthScore = Math.min(response.length / 100, 10); // Normalize to 0-10
      const diversityScore = (uniqueWords.size / words.length) * 10; // 0-10
      const structureScore = Math.min(sentences.length, 5) * 2; // 0-10

      const score = lengthScore + diversityScore + structureScore;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    return results[bestIndex];
  }

  /**
   * Create a LangChain-style evaluation prompt for comparing responses.
   *
   * @private
   */
  private createEvaluationPrompt(
    originalSession: Session<TVars, TAttrs>,
    responses: Array<{ index: number; response: string }>,
  ): string {
    // Get the original user query/context
    const userMessages = originalSession.messages
      .filter((msg) => msg.type === 'user')
      .map((msg) => msg.content)
      .join('\n');

    const systemMessages = originalSession.messages
      .filter((msg) => msg.type === 'system')
      .map((msg) => msg.content)
      .join('\n');

    let prompt = `You are an expert evaluator of AI responses. Your task is to analyze and rank the following responses based on their quality, relevance, completeness, and accuracy.

Context:`;

    if (systemMessages) {
      prompt += `\nSystem Context: ${systemMessages}`;
    }

    if (userMessages) {
      prompt += `\nUser Query: ${userMessages}`;
    }

    prompt += `\n\nResponses to evaluate:\n`;

    for (const { index, response } of responses) {
      prompt += `\n--- Response ${index + 1} ---\n${response}\n`;
    }

    prompt += `\nPlease evaluate these responses based on the following criteria:
1. Relevance to the user's query
2. Accuracy and correctness
3. Completeness of the answer
4. Clarity and coherence
5. Helpfulness and practical value

Return only the number (1-based index) of the best response.`;

    return prompt;
  }

  /**
   * Convert ParallelSourceInput to LlmSource for internal use
   * @private
   */
  private createLlmSource(source: ParallelSourceInput): LlmSource {
    if (typeof source === 'object' && 'getContent' in source) {
      // Already an LlmSource
      return source as LlmSource;
    } else {
      // It's an LLMConfig, convert to Source
      const config = source as LLMConfig;
      let llmSource = Source.llm();

      // Apply provider configuration
      switch (config.provider) {
        case 'openai':
          llmSource = llmSource.openai({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            modelName: config.model || 'gpt-4o-mini',
            dangerouslyAllowBrowser: config.dangerouslyAllowBrowser,
          });
          break;
        case 'anthropic':
          llmSource = llmSource.anthropic({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            modelName: config.model || 'claude-3-5-haiku-latest',
          });
          break;
        case 'google':
          llmSource = llmSource.google({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            modelName: config.model || 'gemini-pro',
          });
          break;
      }

      // Apply generation parameters
      if (config.temperature !== undefined) {
        llmSource = llmSource.temperature(config.temperature);
      }
      if (config.maxTokens !== undefined) {
        llmSource = llmSource.maxTokens(config.maxTokens);
      }
      if (config.topP !== undefined) {
        llmSource = llmSource.topP(config.topP);
      }
      if (config.topK !== undefined) {
        llmSource = llmSource.topK(config.topK);
      }
      if (config.tools !== undefined) {
        llmSource = llmSource.withTools(config.tools);
      }
      if (config.toolChoice !== undefined) {
        llmSource = llmSource.toolChoice(config.toolChoice);
      }
      if (config.schema !== undefined) {
        llmSource = llmSource.withSchema(config.schema, {
          mode: config.mode,
          functionName: config.functionName,
        });
      }

      return llmSource;
    }
  }
}
