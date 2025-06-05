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
 *   .addSource(Source.llm().openai())
 *   .addSource(Source.llm().anthropic());
 *
 * // With repetitions and scoring
 * const parallel = new Parallel()
 *   .addSource(Source.llm().openai(), 3)
 *   .setAggregationFunction(session => session.messages.length)
 *   .setStrategy('best');
 * ```
 *
 * @public
 */
export class Parallel<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
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
   * Add an LLM source to be executed in parallel.
   *
   * @param source - The LLM source to execute
   * @param repetitions - Number of times to execute this source (default: 1)
   * @returns This instance for method chaining
   */
  withSource(source: LlmSource, repetitions: number = 1): this {
    this.sources.push({ source, repetitions });
    return this;
  }

  /**
   * Set multiple sources at once.
   *
   * @param sources - Array of source configurations
   * @returns This instance for method chaining
   */
  withSources(
    sources: Array<{ source: LlmSource; repetitions?: number }>,
  ): this {
    this.sources = sources.map((s) => ({
      source: s.source,
      repetitions: s.repetitions ?? 1,
    }));
    return this;
  }

  /**
   * Set the scoring function used to evaluate sessions when using 'best' strategy.
   *
   * @param scoringFunction - Function that takes a session and returns a numeric score
   * @returns This instance for method chaining
   */
  setAggregationFunction(
    scoringFunction: ScoringFunction<TVars, TAttrs>,
  ): this {
    this.scoringFunction = scoringFunction;
    return this;
  }

  /**
   * Set the strategy for aggregating parallel execution results.
   *
   * @param strategy - Either a built-in strategy name or custom aggregation function
   * @returns This instance for method chaining
   */
  setStrategy(strategy: Strategy<TVars, TAttrs>): this {
    this.strategy = strategy;
    return this;
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
    return this.aggregateResults(results, currentSession);
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
  private aggregateResults(
    results: Session<TVars, TAttrs>[],
    originalSession: Session<TVars, TAttrs>,
  ): Session<TVars, TAttrs> {
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
        return this.aggregateBest(results, originalSession);

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
  private aggregateBest(
    results: Session<TVars, TAttrs>[],
    originalSession: Session<TVars, TAttrs>,
  ): Session<TVars, TAttrs> {
    if (!this.scoringFunction) {
      throw new Error(
        'Scoring function is required when using "best" aggregation strategy. ' +
          'Use setAggregationFunction() to provide one.',
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
}
