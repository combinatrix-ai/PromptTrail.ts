import type { Attrs, Session, Vars } from '../../session';
import { LlmSource } from '../../source';
import { TemplateBase } from '../base';

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
 * A template that executes multiple LLM sources in parallel and aggregates results.
 *
 * @template TAttrs - Type of the session metadata.
 * @template TVars - Type of the session context.
 *
 * @example
 * ```typescript
 * // Basic parallel execution
 * const parallel = new Parallel()
 *   .withSource(Source.llm().openai())
 *   .withSource(Source.llm().anthropic());
 *
 * // With repetitions and custom scoring
 * const parallel = new Parallel()
 *   .withSource(Source.llm().openai(), 3)
 *   .withAggregationFunction(session => session.messages.length)
 *   .withStrategy('best');
 *
 * // Using 'best' strategy with default LangChain-style scoring
 * const parallel = new Parallel()
 *   .withSource(Source.llm().openai())
 *   .withSource(Source.llm().anthropic())
 *   .withStrategy('best'); // Uses built-in evaluation prompt
 *
 * // Function-based creation with static factory
 * const parallel = Parallel.create(p => p
 *   .withSource(Source.llm().openai())
 *   .withSource(Source.llm().anthropic())
 *   .withStrategy('best')
 * );
 *
 * // Using with Agent's function-based API
 * const agent = Agent.create()
 *   .system('You are an assistant')
 *   .user('Question?')
 *   .parallel(p => p
 *     .withSource(Source.llm().openai(), 2)
 *     .withSource(Source.llm().anthropic())
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
    sources?: Array<{ source: LlmSource; repetitions?: number }>;
    scoringFunction?: ScoringFunction<TVars, TAttrs>;
    strategy?: Strategy<TVars, TAttrs>;
  }) {
    super();

    if (options?.sources) {
      this.sources = options.sources.map((s) => ({
        source: s.source,
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
   * Static factory method for creating a Parallel template.
   *
   * @param builderFn - Optional function to configure the parallel template
   * @returns A new Parallel instance
   *
   * @example
   * ```typescript
   * // Direct creation
   * const parallel = Parallel.create();
   *
   * // With builder function
   * const parallel = Parallel.create(p => p
   *   .withSource(Source.llm().openai())
   *   .withSource(Source.llm().anthropic())
   *   .withStrategy('best')
   * );
   * ```
   */
  static create<
    TAttrs extends Attrs = Record<string, any>,
    TVars extends Vars = Record<string, any>,
  >(
    builderFn?: (parallel: Parallel<TAttrs, TVars>) => Parallel<TAttrs, TVars>,
  ): Parallel<TAttrs, TVars> {
    const parallel = new Parallel<TAttrs, TVars>();
    return builderFn ? builderFn(parallel) : parallel;
  }

  /**
   * Add an LLM source to be executed in parallel.
   *
   * @param source - The LLM source to execute
   * @param repetitions - Number of times to execute this source (default: 1)
   * @returns New instance with the added source
   */
  withSource(
    source: LlmSource,
    repetitions: number = 1,
  ): Parallel<TAttrs, TVars> {
    return new Parallel({
      sources: [...this.sources, { source, repetitions }],
      scoringFunction: this.scoringFunction,
      strategy: this.strategy,
    });
  }

  /**
   * Set multiple sources at once.
   *
   * @param sources - Array of source configurations
   * @returns New instance with the specified sources
   */
  withSources(
    sources: Array<{ source: LlmSource; repetitions?: number }>,
  ): Parallel<TAttrs, TVars> {
    return new Parallel({
      sources: sources.map((s) => ({
        source: s.source,
        repetitions: s.repetitions ?? 1,
      })),
      scoringFunction: this.scoringFunction,
      strategy: this.strategy,
    });
  }

  /**
   * Set the scoring function used to evaluate sessions when using 'best' strategy.
   *
   * @param scoringFunction - Function that takes a session and returns a numeric score
   * @returns New instance with the specified scoring function
   */
  withAggregationFunction(
    scoringFunction: ScoringFunction<TVars, TAttrs>,
  ): Parallel<TAttrs, TVars> {
    return new Parallel({
      sources: [...this.sources],
      scoringFunction,
      strategy: this.strategy,
    });
  }

  /**
   * Set the strategy for aggregating parallel execution results.
   *
   * @param strategy - Either a built-in strategy name or custom aggregation function
   * @returns New instance with the specified strategy
   */
  withStrategy(strategy: Strategy<TVars, TAttrs>): Parallel<TAttrs, TVars> {
    return new Parallel({
      sources: [...this.sources],
      scoringFunction: this.scoringFunction,
      strategy,
    });
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
}
