// content_source.ts
import * as readline from 'node:readline/promises';
import { z } from 'zod';
import type {
  ApprovalHandler,
  CapabilitySet,
  McpTransport,
} from './capabilities';
import type { PromptTrailTool } from './capabilities';
import { ValidationError } from './errors';
import {
  generateText,
  generateTextStream,
  generateWithSchema,
} from './generate';
import type { ExecutionRuntimeState } from './interceptors';
import type {
  AnthropicProviderConfig,
  AnthropicToolChoice,
  GoogleProviderConfig,
  LLMOptions,
  ModelOutput,
  OpenAIProviderConfig,
  ProviderConfig,
  SchemaGenerationMode,
  SchemaGenerationOptions,
} from './llm_types';
import { aiSdkToolToPromptTrailTool } from './ai_sdk_tools';
import type { Session, Vars } from './session';
import { isPromptTrailTool } from './tool';
import { interpolateTemplate } from './utils/template_interpolation';
import type {
  IValidator,
  TValidationResult as ValidationResult,
} from './validators/base';

// --- Debug Mode Configuration ---

/**
 * Get debug mode configuration for LLM sources
 */
function isDebugMode(): boolean {
  return process.env.PROMPTTRAIL_DEBUG === 'true';
}

function getMaxLLMCalls(): number {
  return process.env.PROMPTTRAIL_MAX_LLM_CALLS
    ? parseInt(process.env.PROMPTTRAIL_MAX_LLM_CALLS, 10)
    : 100;
}

/**
 * Global call counter for LLM sources in debug mode
 */
const llmCallCounter = new Map<string, number>();

function manifestDescriptorValue(
  value: unknown,
  seen = new WeakSet<object>(),
  key?: string,
): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'function') {
    if (key === 'shape') {
      try {
        return manifestDescriptorValue(value(), seen);
      } catch {
        return { kind: 'function', name: value.name || undefined };
      }
    }
    return { kind: 'function', name: value.name || undefined };
  }
  if (typeof value !== 'object') {
    return { kind: typeof value };
  }
  if (seen.has(value)) {
    return { kind: 'circular' };
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => manifestDescriptorValue(item, seen));
    }
    if (value instanceof RegExp) {
      return { kind: 'regexp', source: value.source, flags: value.flags };
    }
    if (isZodSchemaLike(value)) {
      return zodSchemaManifestDescriptor(value, seen);
    }
    if (!isPlainObject(value)) {
      return {
        kind: 'object',
        ctor: value.constructor?.name || undefined,
      };
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((entryKey) => [
          entryKey,
          manifestDescriptorValue(record[entryKey], seen, entryKey),
        ]),
    );
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isZodSchemaLike(value: object): value is z.ZodType {
  const definition = (value as { _def?: unknown })._def;
  return (
    typeof definition === 'object' &&
    definition !== null &&
    typeof (definition as { typeName?: unknown }).typeName === 'string'
  );
}

function zodSchemaManifestDescriptor(
  schema: z.ZodType,
  seen = new WeakSet<object>(),
) {
  const definition = (schema as { _def?: unknown })._def;
  return {
    typeName:
      typeof definition === 'object' && definition !== null
        ? (definition as { typeName?: unknown }).typeName
        : schema.constructor?.name || undefined,
    definition: manifestDescriptorValue(definition, seen),
  };
}

function llmProviderManifestDescriptor(provider: ProviderConfig) {
  const base = {
    type: provider.type,
    modelName: provider.modelName,
    adapter: provider.adapter,
    baseURL: provider.baseURL ? { present: true } : undefined,
    apiKey: provider.apiKey ? { present: true } : undefined,
  };
  switch (provider.type) {
    case 'openai':
      return {
        ...base,
        api: provider.api,
        organization: provider.organization ? { present: true } : undefined,
        dangerouslyAllowBrowser: provider.dangerouslyAllowBrowser,
      };
    case 'anthropic':
      return base;
    case 'google':
      return {
        ...base,
        retry: provider.retry,
      };
  }
}

function llmGenerationManifestDescriptor(options: LLMOptions) {
  return {
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    topP: options.topP,
    topK: options.topK,
    toolChoice: options.toolChoice,
    retain: options.retain,
    conversationBinding: options.conversationBinding,
    skillInjection: options.skillInjection,
    maxCallLimit: options.maxCallLimit,
    dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
    cacheKey: options.cacheKey ? { present: true } : undefined,
    cacheRetention: options.cacheRetention,
    compaction: options.compaction,
    thinking: options.thinking,
    aiSdk: options.aiSdk
      ? {
          providerOptionProviders: options.aiSdk.providerOptions
            ? Object.keys(options.aiSdk.providerOptions).sort()
            : undefined,
          sdkOptionKeys: options.aiSdk.sdkOptions
            ? Object.keys(options.aiSdk.sdkOptions).sort()
            : undefined,
        }
      : undefined,
    anthropic: options.anthropic,
    approvalHandler: options.approvalHandler
      ? { present: true, name: options.approvalHandler.name || undefined }
      : undefined,
    context: options.context ? { present: true } : undefined,
  };
}

function capabilitySetManifestDescriptor(
  capabilities: CapabilitySet | undefined,
) {
  if (!capabilities?.length) {
    return undefined;
  }
  return capabilities?.map((capability) => {
    switch (capability.kind) {
      case 'tool':
        return promptTrailToolManifestDescriptor(capability);
      case 'skill':
        return {
          kind: capability.kind,
          name: capability.name,
          description: capability.description,
          instructions: capability.instructions,
          path: capability.path,
          skillId: capability.skillId,
          materialize: capability.materialize,
          cache: capability.cache,
          metadataKeys: objectKeysManifestDescriptor(capability.metadata),
        };
      case 'builtin':
        return {
          kind: capability.kind,
          name: capability.name,
          provider: capability.provider,
          executionMode: capability.executionMode,
          configKeys: objectKeysManifestDescriptor(capability.config),
          approval: approvalManifestDescriptor(capability.approval),
          cache: capability.cache,
          metadataKeys: objectKeysManifestDescriptor(capability.metadata),
        };
      case 'mcp':
        return {
          kind: capability.kind,
          name: capability.name,
          transport: mcpTransportManifestDescriptor(capability.transport),
          tools: capability.tools,
          effects: capability.effects
            ? {
                defaults: capability.effects.defaults,
                perTool: capability.effects.perTool,
              }
            : undefined,
          approval: approvalManifestDescriptor(capability.approval),
          cache: capability.cache,
        };
    }
  });
}

function promptTrailToolManifestDescriptor(tool: PromptTrailTool<any, any>) {
  return {
    kind: tool.kind,
    name: tool.name,
    description: tool.description,
    inputSchema: zodSchemaManifestDescriptor(tool.inputSchema),
    execute: { kind: 'function', name: tool.execute.name || undefined },
    activity: tool.activity ?? tool.metadata?.activity,
    approval: approvalManifestDescriptor(tool.approval),
    cache: tool.cache,
    metadataKeys: objectKeysManifestDescriptor(tool.metadata),
  };
}

function promptTrailToolsManifestDescriptor(
  tools: Record<string, PromptTrailTool<any, any>> | undefined,
) {
  const entries = Object.values(tools ?? {}).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  return entries.length
    ? entries.map((tool) => promptTrailToolManifestDescriptor(tool))
    : undefined;
}

function approvalManifestDescriptor(approval: unknown) {
  return typeof approval === 'function'
    ? { kind: 'function', name: approval.name || undefined }
    : approval;
}

function objectKeysManifestDescriptor(
  value: Record<string, unknown> | undefined,
) {
  return value ? Object.keys(value).sort() : undefined;
}

function mcpTransportManifestDescriptor(transport: McpTransport) {
  if (transport.kind === 'stdio') {
    return {
      kind: transport.kind,
      command: transport.command,
      args: transport.args,
      envKeys: transport.env ? Object.keys(transport.env).sort() : undefined,
    };
  }
  if (transport.kind === 'http') {
    return {
      kind: transport.kind,
      url: transport.url,
      headerKeys: transport.headers
        ? Object.keys(transport.headers).sort()
        : undefined,
    };
  }
  return {
    kind: transport.kind,
    server: { present: true },
  };
}

export type {
  AnthropicProviderConfig,
  GoogleProviderConfig,
  LLMOptions,
  ModelOutput,
  OpenAIProviderConfig,
  ProviderConfig,
  SchemaGenerationOptions,
} from './llm_types';

export interface SourceManifestDescriptor {
  kind: 'source';
  sourceType: string;
  validation?: {
    validator?: string;
    maxAttempts: number;
    raiseError: boolean;
  };
  config?: unknown;
}

/**
 * Options for validation behavior
 */
export interface ValidationOptions {
  validator?: IValidator;
  maxAttempts?: number;
  raiseError?: boolean;
}

/**
 * Base class for all content sources (Renamed from ContentSource)
 */
export abstract class Source<T = unknown> {
  protected validator?: IValidator;
  protected maxAttempts: number;
  protected raiseError: boolean;

  constructor(options?: ValidationOptions) {
    this.validator = options?.validator;
    this.maxAttempts = options?.maxAttempts ?? 1;
    this.raiseError = options?.raiseError ?? true;
  }

  /**
   * Get content with session context
   * @param session Session context for content generation
   * @returns Promise resolving to content of type T
   */
  abstract getContent(
    session: Session<any, any>,
    runtime?: ExecutionRuntimeState<any, any>,
  ): Promise<T>;

  /**
   * Validates the given content once using the assigned validator.
   * Does NOT handle retries internally. Retries should be handled by the calling method (e.g., getContent).
   */
  protected async validateContent(
    content: string,
    session: Session<any, any>,
  ): Promise<ValidationResult> {
    if (!this.validator) {
      return { isValid: true }; // No validator means content is considered valid
    }
    // Perform a single validation attempt
    return this.validator.validate(content, session);
  }

  /**
   * Check if this content source has a validator
   * @returns True if a validator is available
   */
  hasValidator(): boolean {
    return !!this.validator;
  }

  /**
   * Get the validator associated with this content source
   * @returns The validator or undefined if no validator is set
   */
  getValidator(): IValidator | undefined {
    return this.validator;
  }

  getManifestDescriptor(): SourceManifestDescriptor {
    return {
      kind: 'source',
      sourceType: this.constructor?.name || 'Source',
      validation: this.validationManifestDescriptor(),
    };
  }

  protected validationManifestDescriptor():
    | SourceManifestDescriptor['validation']
    | undefined {
    if (!this.validator && this.maxAttempts === 1 && this.raiseError === true) {
      return undefined;
    }
    return {
      validator: this.validator?.constructor?.name || undefined,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };
  }
}

/**
 * Base class for sources returning simple string content (Renamed from StringContentSource)
 */
export abstract class StringSource extends Source<string> {
  // Returns plain string content
}

/**
 * Base class for sources returning AI model outputs (Renamed from ModelContentSource)
 */
export abstract class ModelSource extends Source<ModelOutput> {
  // Returns structured content with content, toolCalls, structuredOutput and metadata
}

/**
 * Content source that returns a random element from a predefined list
 */
export class RandomSource extends StringSource {
  constructor(
    private contentList: string[],
    options?: ValidationOptions,
  ) {
    super(options);
  }

  async getContent(_session: Session<any, any>): Promise<string> {
    const randomIndex = Math.floor(Math.random() * this.contentList.length);
    return this.contentList[randomIndex];
  }

  getManifestDescriptor(): SourceManifestDescriptor {
    return {
      ...super.getManifestDescriptor(),
      config: { itemCount: this.contentList.length },
    };
  }
}

/**
 * Content source that returns elements from a predefined list sequentially.
 * By default, it throws an error when the list is exhausted.
 * If `loop` is set to true in options, it restarts from the beginning.
 */
export class ListSource extends StringSource {
  private index: number = 0;
  private loop: boolean;

  constructor(
    private contentList: string[],
    options?: ValidationOptions & { loop?: boolean },
  ) {
    super(options);
    this.loop = options?.loop ?? false;
  }

  async getContent(session: Session<any, any>): Promise<string> {
    if (this.index < this.contentList.length) {
      const content = this.contentList[this.index++];
      // Apply validation if a validator exists
      const validationResult = await this.validateContent(content, session);
      if (!validationResult.isValid && this.raiseError) {
        const errorMessage = `Validation failed for item at index ${this.index - 1}: ${validationResult.instruction || ''}`;
        throw new ValidationError(errorMessage);
      }
      // Return content if valid or if raiseError is false
      return content;
    } else if (this.loop) {
      this.index = 0; // Reset index to loop
      if (this.index < this.contentList.length) {
        // Check if list is not empty
        const content = this.contentList[this.index++];
        // Apply validation if a validator exists
        const validationResult = await this.validateContent(content, session);
        if (!validationResult.isValid && this.raiseError) {
          const errorMessage = `Validation failed for item at index ${this.index - 1} (looping): ${validationResult.instruction || ''}`;
          throw new ValidationError(errorMessage);
        }
        // Return content if valid or if raiseError is false
        return content;
      } else {
        // Handle empty list case during loop reset
        throw new Error('ListSource is empty.');
      }
    } else {
      throw new Error('No more content in the ListSource.');
    }
  }

  /**
   * Gets the current index.
   */
  getIndex(): number {
    return this.index;
  }

  /**
   * Checks if the source is at the end of the list (and not looping).
   */
  atEnd(): boolean {
    return !this.loop && this.index >= this.contentList.length;
  }

  getManifestDescriptor(): SourceManifestDescriptor {
    return {
      ...super.getManifestDescriptor(),
      config: {
        itemCount: this.contentList.length,
        loop: this.loop,
      },
    };
  }
}

/**
 * CLI input source with fluent API that reads from command line
 */
export class CLISource extends StringSource {
  private promptText: string;
  private defaultVal?: string;

  constructor(
    prompt: string = '',
    defaultValue?: string,
    options?: ValidationOptions,
  ) {
    super(options);
    this.promptText = prompt;
    this.defaultVal = defaultValue;
  }

  // Helper method to create new instance with merged options
  private clone(
    newPrompt?: string,
    newDefaultValue?: string,
    newValidationOptions?: ValidationOptions,
  ): CLISource {
    const mergedValidationOptions = newValidationOptions || {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };

    return new CLISource(
      newPrompt ?? this.promptText,
      newDefaultValue ?? this.defaultVal,
      mergedValidationOptions,
    );
  }

  // Fluent API methods - all return new instances
  prompt(text: string): CLISource {
    return this.clone(text, this.defaultVal);
  }

  defaultValue(value: string): CLISource {
    return this.clone(this.promptText, value);
  }

  validate(validator: IValidator): CLISource {
    return this.clone(this.promptText, this.defaultVal, {
      validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    });
  }

  withMaxAttempts(attempts: number): CLISource {
    return this.clone(this.promptText, this.defaultVal, {
      validator: this.validator,
      maxAttempts: attempts,
      raiseError: this.raiseError,
    });
  }

  withRaiseError(raise: boolean): CLISource {
    return this.clone(this.promptText, this.defaultVal, {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: raise,
    });
  }

  async getContent(session: Session<any, any>): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      let attempts = 0;
      let lastResult: ValidationResult | undefined;
      let currentInput = '';

      while (attempts < this.maxAttempts) {
        attempts++;
        const rawInput = await rl.question(this.promptText);
        currentInput = rawInput || this.defaultVal || '';

        lastResult = await this.validateContent(currentInput, session);

        if (lastResult.isValid) {
          return currentInput;
        }

        const isLastAttempt = attempts >= this.maxAttempts;

        if (isLastAttempt) {
          if (this.raiseError) {
            const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
            throw new ValidationError(errorMessage);
          } else {
            console.warn(
              `CLISource: Validation failed after ${attempts} attempts. Returning last input or default value.`,
            );
            return currentInput;
          }
        } else {
          console.log(
            `Validation attempt ${attempts} failed: ${
              lastResult?.instruction || 'Invalid input'
            }. Please try again.`,
          );
        }
      }
      return this.defaultVal || '';
    } finally {
      rl.close();
    }
  }

  getManifestDescriptor(): SourceManifestDescriptor {
    return {
      ...super.getManifestDescriptor(),
      config: {
        prompt: this.promptText,
        hasDefault: this.defaultVal !== undefined,
      },
    };
  }
}

/**
 * Callback-based content source with fluent API
 */
export class CallbackSource extends StringSource {
  private callback: (context: { context?: Vars }) => Promise<string>;

  constructor(
    callback: (context: { context?: Vars }) => Promise<string>,
    options?: ValidationOptions,
  ) {
    super(options);
    this.callback = callback;
  }

  // Helper method to create new instance with merged options
  private clone(
    newCallback?: (context: { context?: Vars }) => Promise<string>,
    newValidationOptions?: ValidationOptions,
  ): CallbackSource {
    const mergedValidationOptions = newValidationOptions || {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };

    return new CallbackSource(
      newCallback ?? this.callback,
      mergedValidationOptions,
    );
  }

  // Fluent API methods - all return new instances
  withCallback(
    callback: (context: { context?: Vars }) => Promise<string>,
  ): CallbackSource {
    return this.clone(callback);
  }

  validate(validator: IValidator): CallbackSource {
    return this.clone(this.callback, {
      validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    });
  }

  withMaxAttempts(attempts: number): CallbackSource {
    return this.clone(this.callback, {
      validator: this.validator,
      maxAttempts: attempts,
      raiseError: this.raiseError,
    });
  }

  withRaiseError(raise: boolean): CallbackSource {
    return this.clone(this.callback, {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: raise,
    });
  }

  async getContent(session: Session<any, any>): Promise<string> {
    let attempts = 0;
    let lastResult: ValidationResult | undefined;
    let currentInput = '';

    while (attempts < this.maxAttempts) {
      attempts++;
      currentInput = await this.callback({ context: session.vars });
      lastResult = await this.validateContent(currentInput, session);

      if (lastResult.isValid) {
        return currentInput;
      }

      const isLastAttempt = attempts >= this.maxAttempts;

      if (isLastAttempt) {
        if (this.raiseError) {
          const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
          throw new ValidationError(errorMessage);
        } else {
          console.warn(
            `CallbackSource: Validation failed after ${attempts} attempts. Returning last (invalid) input.`,
          );
          return currentInput;
        }
      } else {
        console.log(
          `Validation attempt ${attempts} failed: ${
            lastResult?.instruction || 'Invalid input'
          }. Retrying...`,
        );
      }
    }

    if (!this.raiseError) {
      return currentInput;
    } else {
      throw new Error(
        `Callback input validation failed unexpectedly after ${this.maxAttempts} attempts.`,
      );
    }
  }

  getManifestDescriptor(): SourceManifestDescriptor {
    return {
      ...super.getManifestDescriptor(),
      config: {
        callback: this.callback.name || undefined,
      },
    };
  }
}

/**
 * Static text content source with fluent API
 */
export class LiteralSource extends StringSource {
  private content: string;

  constructor(content: string, options?: ValidationOptions) {
    super(options);
    this.content = content;
  }

  // Helper method to create new instance with merged options
  private clone(
    newContent?: string,
    newValidationOptions?: ValidationOptions,
  ): LiteralSource {
    const mergedValidationOptions = newValidationOptions || {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };

    return new LiteralSource(
      newContent ?? this.content,
      mergedValidationOptions,
    );
  }

  // Fluent API methods - all return new instances
  withContent(content: string): LiteralSource {
    return this.clone(content);
  }

  validate(validator: IValidator): LiteralSource {
    return this.clone(this.content, {
      validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    });
  }

  withMaxAttempts(attempts: number): LiteralSource {
    return this.clone(this.content, {
      validator: this.validator,
      maxAttempts: attempts,
      raiseError: this.raiseError,
    });
  }

  withRaiseError(raise: boolean): LiteralSource {
    return this.clone(this.content, {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: raise,
    });
  }

  async getContent(session: Session<any, any>): Promise<string> {
    const interpolatedContent = interpolateTemplate(this.content, session);
    const validationResult = await this.validateContent(
      interpolatedContent,
      session,
    );
    if (!validationResult.isValid && this.raiseError) {
      const errorMessage = `Validation failed: ${validationResult.instruction || ''}`;
      throw new ValidationError(errorMessage);
    }
    return interpolatedContent;
  }

  getManifestDescriptor(): SourceManifestDescriptor {
    return {
      ...super.getManifestDescriptor(),
      config: {
        content: this.content,
      },
    };
  }
}

/**
 * Mock response configuration
 */
export interface MockResponse {
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    id: string;
  }>;
  toolResults?: Array<{
    toolCallId: string;
    result: unknown;
  }>;
  metadata?: Record<string, unknown>;
  structuredOutput?: Record<string, unknown>;
}

/**
 * Mock callback function type
 */
export type MockCallback = (
  session: Session<any, any>,
  options: LLMOptions,
) => Promise<MockResponse> | MockResponse;

/**
 * Internal state for mocked LlmSource
 */
interface MockState {
  mockResponses: MockResponse[];
  mockCallback?: MockCallback;
  currentResponseIndex: number;
  callHistory: Array<{
    session: Session<any, any>;
    options: LLMOptions;
    response: MockResponse;
  }>;
  isMocked: true;
}

/**
 * MockedLlmSource type that adds mock-specific methods to LlmSource
 */
export interface MockedLlmSource extends LlmSource {
  mockResponse(response: MockResponse): MockedLlmSource;
  mockResponses(...responses: MockResponse[]): MockedLlmSource;
  mockCallback(callback: MockCallback): MockedLlmSource;
  getCallHistory(): Array<{
    session: Session<any, any>;
    options: LLMOptions;
    response: MockResponse;
  }>;
  getLastCall():
    | {
        session: Session<any, any>;
        options: LLMOptions;
        response: MockResponse;
      }
    | undefined;
  getCallCount(): number;
  reset(): MockedLlmSource;
}

function normalizeLlmSourceTool(
  name: string,
  tool: unknown,
): PromptTrailTool<any, any> {
  if (isPromptTrailTool(tool)) {
    return tool;
  }
  return aiSdkToolToPromptTrailTool(name, tool as never);
}

/**
 * Source for LLM content generation, with immutable and fluent configuration
 */
export class LlmSource extends ModelSource {
  protected readonly options: LLMOptions;
  protected schemaConfig?: SchemaGenerationOptions;
  protected instanceId: string;
  protected readonly maxCallLimit: number;
  protected _mockState?: MockState;

  constructor(
    options?: Partial<LLMOptions>,
    validationOptions?: ValidationOptions,
  ) {
    super(validationOptions);

    // Set sensible defaults
    this.options = {
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || '',
        modelName: 'gpt-5.4-nano',
        api: 'responses',
        adapter: 'native',
      },
      temperature: 0.7,
      ...options,
    };

    // Generate unique instance ID for tracking
    this.instanceId = `llm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Set max call limit from options or environment
    this.maxCallLimit = options?.maxCallLimit ?? getMaxLLMCalls();

    // Initialize counter for this instance in debug mode
    if (isDebugMode()) {
      llmCallCounter.set(this.instanceId, 0);
    }
  }

  getManifestDescriptor(): SourceManifestDescriptor {
    return {
      ...super.getManifestDescriptor(),
      config: {
        provider: llmProviderManifestDescriptor(this.options.provider),
        generation: llmGenerationManifestDescriptor(this.options),
        schema: this.schemaConfig
          ? {
              mode: this.schemaConfig.mode ?? 'native',
              functionName: this.schemaConfig.functionName,
              schema: zodSchemaManifestDescriptor(this.schemaConfig.schema),
            }
          : undefined,
        tools: promptTrailToolsManifestDescriptor(this.options.tools),
        capabilities: capabilitySetManifestDescriptor(
          this.options.capabilities,
        ),
        mocked: this._mockState
          ? {
              responseCount: this._mockState.mockResponses.length,
              callback: this._mockState.mockCallback?.name || undefined,
            }
          : undefined,
      },
    };
  }

  // Helper method to create new instance with merged options
  private clone(
    newOptions: Partial<LLMOptions>,
    newValidationOptions?: ValidationOptions,
  ): LlmSource {
    const mergedOptions: LLMOptions = {
      ...this.options,
      ...newOptions,
      // Deep merge provider config
      provider: {
        ...this.options.provider,
        ...(newOptions.provider || {}),
      },
      // Deep merge tools
      tools: {
        ...this.options.tools,
        ...newOptions.tools,
      },
      capabilities: [
        ...(this.options.capabilities ?? []),
        ...(newOptions.capabilities ?? []),
      ],
      anthropic: {
        ...this.options.anthropic,
        ...newOptions.anthropic,
      },
      // Preserve maxCallLimit unless explicitly overridden
      maxCallLimit: newOptions.maxCallLimit ?? this.maxCallLimit,
    };

    const mergedValidationOptions = newValidationOptions || {
      validator: this.validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    };

    const newSource = new LlmSource(mergedOptions, mergedValidationOptions);
    // Copy schema configuration
    if (this.schemaConfig) {
      newSource.schemaConfig = { ...this.schemaConfig };
    }

    // In debug mode, share the same counter for cloned instances
    if (isDebugMode() && llmCallCounter.has(this.instanceId)) {
      llmCallCounter.delete(newSource.instanceId);
      newSource.instanceId = this.instanceId;
    }

    return newSource;
  }

  // Provider configuration - all return new instances
  openai(config?: Partial<Omit<OpenAIProviderConfig, 'type'>>): LlmSource {
    return this.clone({
      provider: {
        type: 'openai',
        apiKey: config?.apiKey || process.env.OPENAI_API_KEY || '',
        modelName: config?.modelName || 'gpt-5.4-nano',
        api: config?.api ?? 'responses',
        adapter: config?.adapter ?? 'native',
        baseURL: config?.baseURL,
        organization: config?.organization,
        dangerouslyAllowBrowser: config?.dangerouslyAllowBrowser,
      },
    });
  }

  anthropic(
    config?: Partial<Omit<AnthropicProviderConfig, 'type'>>,
  ): LlmSource {
    return this.clone({
      provider: {
        type: 'anthropic',
        apiKey: config?.apiKey || process.env.ANTHROPIC_API_KEY || '',
        modelName: config?.modelName || 'claude-haiku-4-5',
        adapter: config?.adapter ?? 'native',
        baseURL: config?.baseURL,
      },
    });
  }

  google(config?: Partial<Omit<GoogleProviderConfig, 'type'>>): LlmSource {
    return this.clone({
      provider: {
        type: 'google',
        apiKey: config?.apiKey || process.env.GOOGLE_API_KEY,
        modelName: config?.modelName || 'gemini-3.1-flash-lite',
        adapter: config?.adapter ?? 'native',
        baseURL: config?.baseURL,
        retry: config?.retry,
      },
    });
  }

  // Model configuration - all return new instances
  model(modelName: string): LlmSource {
    return this.clone({
      provider: {
        ...this.options.provider,
        modelName,
      },
    });
  }

  apiKey(apiKey: string): LlmSource {
    return this.clone({
      provider: {
        ...this.options.provider,
        apiKey,
      },
    });
  }

  openaiApi(api: 'chat' | 'responses'): LlmSource {
    if (this.options.provider.type !== 'openai') {
      throw new Error('openaiApi() can only be used with the OpenAI provider.');
    }

    return this.clone({
      provider: {
        ...this.options.provider,
        api,
      },
    });
  }

  // Generation parameters - all return new instances
  temperature(value: number): LlmSource {
    return this.clone({ temperature: value });
  }

  maxTokens(value: number): LlmSource {
    return this.clone({ maxTokens: value });
  }

  topP(value: number): LlmSource {
    return this.clone({ topP: value });
  }

  topK(value: number): LlmSource {
    return this.clone({ topK: value });
  }

  // Tool configuration - all return new instances. Raw ai-sdk tools are
  // adapted on entry: downstream tool plumbing only handles PromptTrail
  // tools, and an unadapted ai-sdk tool would otherwise never reach the
  // model request.
  addTool(name: string, tool: PromptTrailTool<any, any> | unknown): LlmSource {
    return this.clone({
      tools: {
        ...this.options.tools,
        [name]: normalizeLlmSourceTool(name, tool),
      },
    });
  }

  withTool(name: string, tool: PromptTrailTool<any, any> | unknown): LlmSource {
    return this.clone({
      tools: {
        ...this.options.tools,
        [name]: normalizeLlmSourceTool(name, tool),
      },
    });
  }

  withTools(
    tools: Record<string, PromptTrailTool<any, any> | unknown>,
  ): LlmSource {
    return this.clone({
      tools: Object.fromEntries(
        Object.entries({ ...this.options.tools, ...tools }).map(
          ([name, tool]) => [name, normalizeLlmSourceTool(name, tool)],
        ),
      ),
    });
  }

  withCapabilities(capabilities: CapabilitySet): LlmSource {
    return this.clone({
      capabilities,
      tools: Object.fromEntries(
        capabilities
          .filter(isPromptTrailTool)
          .map((capability) => [capability.name, capability]),
      ),
    });
  }

  toolChoice(choice: 'auto' | 'required' | 'none'): LlmSource {
    return this.clone({ toolChoice: choice });
  }

  anthropicToolChoice(choice: AnthropicToolChoice): LlmSource {
    return this.clone({
      anthropic: {
        ...this.options.anthropic,
        toolChoice: choice,
      },
    });
  }

  conversationBinding(mode: 'off' | 'auto' = 'auto'): LlmSource {
    return this.clone({ conversationBinding: mode });
  }

  skillInjection(policy: 'warn' | 'error' | 'silent'): LlmSource {
    return this.clone({ skillInjection: policy });
  }

  approvalHandler(handler: ApprovalHandler): LlmSource {
    return this.clone({ approvalHandler: handler });
  }

  // Browser compatibility - returns new instance
  dangerouslyAllowBrowser(allow: boolean = true): LlmSource {
    const newOptions: Partial<LLMOptions> = {
      dangerouslyAllowBrowser: allow,
    };

    // Also update provider-specific setting for OpenAI
    if (this.options.provider.type === 'openai') {
      newOptions.provider = {
        ...this.options.provider,
        dangerouslyAllowBrowser: allow,
      };
    }

    return this.clone(newOptions);
  }

  // Debug mode configuration - returns new instance
  maxCalls(limit: number): LlmSource {
    return this.clone({ maxCallLimit: limit });
  }

  // Schema configuration - returns new instance
  withSchema<T>(
    schema: z.ZodType<T>,
    options?: {
      mode?: SchemaGenerationMode;
      functionName?: string;
    },
  ): LlmSource {
    const newSource = this.clone({});
    newSource.schemaConfig = {
      schema,
      mode: options?.mode,
      functionName: options?.functionName || 'generateStructuredOutput',
    };
    return newSource;
  }

  // Validation configuration - returns new instance
  validate(validator: IValidator): LlmSource {
    const newSource = this.clone({});
    // Create new instance with updated validation
    return new LlmSource(newSource.options, {
      validator,
      maxAttempts: this.maxAttempts,
      raiseError: this.raiseError,
    });
  }

  withMaxAttempts(attempts: number): LlmSource {
    return this.clone(
      {},
      {
        validator: this.validator,
        maxAttempts: attempts,
        raiseError: this.raiseError,
      },
    );
  }

  withRaiseError(raise: boolean): LlmSource {
    return this.clone(
      {},
      {
        validator: this.validator,
        maxAttempts: this.maxAttempts,
        raiseError: raise,
      },
    );
  }

  /** Get the instance ID for this LlmSource (useful for debugging/testing) */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Create a mocked version of this LlmSource for testing.
   * The mocked version intercepts generateText calls and returns mock responses.
   */
  mock(): MockedLlmSource {
    // Create a clone with mock state
    const mockSource = Object.create(this) as LlmSource & MockedLlmSource;

    // Initialize mock state
    mockSource._mockState = {
      mockResponses: [],
      mockCallback: undefined,
      currentResponseIndex: 0,
      callHistory: [],
      isMocked: true,
    };

    // Add mock-specific methods
    mockSource.mockResponse = function (
      response: MockResponse,
    ): MockedLlmSource {
      this._mockState!.mockResponses = [response];
      this._mockState!.currentResponseIndex = 0;
      return this;
    };

    mockSource.mockResponses = function (
      ...responses: MockResponse[]
    ): MockedLlmSource {
      this._mockState!.mockResponses = responses;
      this._mockState!.currentResponseIndex = 0;
      return this;
    };

    mockSource.mockCallback = function (
      callback: MockCallback,
    ): MockedLlmSource {
      this._mockState!.mockCallback = callback;
      return this;
    };

    mockSource.getCallHistory = function () {
      return [...this._mockState!.callHistory];
    };

    mockSource.getLastCall = function () {
      const history = this._mockState!.callHistory;
      return history[history.length - 1];
    };

    mockSource.getCallCount = function (): number {
      return this._mockState!.callHistory.length;
    };

    mockSource.reset = function (): MockedLlmSource {
      this._mockState!.currentResponseIndex = 0;
      this._mockState!.callHistory = [];
      return this;
    };

    return mockSource;
  }

  /**
   * Generate mock response and apply validation
   */
  private async _generateMockResponse(
    session: Session<any, any>,
  ): Promise<ModelOutput> {
    if (!this._mockState) {
      throw new Error('_generateMockResponse called on non-mocked source');
    }

    let attempts = 0;
    let lastResult: ValidationResult | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;

      try {
        // Generate mock response
        let mockResponse: MockResponse;

        if (this._mockState.mockCallback) {
          mockResponse = await this._mockState.mockCallback(
            session,
            this.options,
          );
        } else if (this._mockState.mockResponses.length > 0) {
          mockResponse =
            this._mockState.mockResponses[this._mockState.currentResponseIndex];
          this._mockState.currentResponseIndex =
            (this._mockState.currentResponseIndex + 1) %
            this._mockState.mockResponses.length;
        } else {
          mockResponse = { content: 'Mock LLM response' };
        }

        // Record the call
        this._mockState.callHistory.push({
          session,
          options: this.options,
          response: mockResponse,
        });

        const responseContent = mockResponse.content;

        // Apply validation if configured (same as real LLM)
        if (this.validator) {
          lastResult = await this.validateContent(responseContent, session);

          if (lastResult.isValid) {
            return {
              content: responseContent,
              toolCalls: mockResponse.toolCalls,
              toolResults: mockResponse.toolResults,
              metadata: mockResponse.metadata,
              structuredOutput: mockResponse.structuredOutput,
            };
          }

          // Handle validation failure
          const isLastAttempt = attempts >= this.maxAttempts;

          if (isLastAttempt) {
            if (this.raiseError) {
              const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
              throw new ValidationError(errorMessage);
            } else {
              console.warn(
                `MockSource: Validation failed after ${attempts} attempts. Returning last generated content.`,
              );
              return {
                content: responseContent,
                toolCalls: mockResponse.toolCalls,
                toolResults: mockResponse.toolResults,
                metadata: mockResponse.metadata,
                structuredOutput: mockResponse.structuredOutput,
              };
            }
          } else {
            console.log(
              `Mock validation attempt ${attempts} failed: ${lastResult?.instruction || 'Invalid input'}. Retrying...`,
            );
          }
        } else {
          // No validation, return directly
          return {
            content: responseContent,
            toolCalls: mockResponse.toolCalls,
            toolResults: mockResponse.toolResults,
            metadata: mockResponse.metadata,
            structuredOutput: mockResponse.structuredOutput,
          };
        }
      } catch (error) {
        if (attempts >= this.maxAttempts) {
          if (this.raiseError) {
            throw error;
          } else {
            return { content: '' };
          }
        }
        console.log(`Mock generation attempt ${attempts} failed, retrying...`);
      }
    }

    throw new Error(
      `Mock content generation failed unexpectedly after ${this.maxAttempts} attempts.`,
    );
  }

  async getContent(
    session: Session<any, any>,
    runtime?: ExecutionRuntimeState<any, any>,
  ): Promise<ModelOutput> {
    // Check if this is a mocked source
    if (this._mockState) {
      return this._generateMockResponse(session);
    }

    // Check call limit in debug mode
    if (isDebugMode()) {
      const currentCalls = llmCallCounter.get(this.instanceId) || 0;
      if (currentCalls >= this.maxCallLimit) {
        throw new Error(
          `LlmSource call limit exceeded: ${currentCalls} calls made, limit is ${this.maxCallLimit}. ` +
            `This safety check prevents infinite loops during development. ` +
            `Set PROMPTTRAIL_DEBUG=false or increase PROMPTTRAIL_MAX_LLM_CALLS to disable.`,
        );
      }
      llmCallCounter.set(this.instanceId, currentCalls + 1);
    }

    let attempts = 0;
    let lastResult: ValidationResult | undefined;

    while (attempts < this.maxAttempts) {
      attempts++;

      try {
        let response: any;

        if (this.schemaConfig) {
          // Use schema-based generation
          response = await generateWithSchema(
            session,
            this.options,
            this.schemaConfig,
          );
        } else if (
          runtime &&
          isFirstPartyNativeProvider(this.options) &&
          hasPromptTrailTools(this.options)
        ) {
          response = await this.generateWithRuntimeToolLoop(session, runtime);
        } else {
          // Use regular generation
          response = await generateText(session, this.options);
        }

        const responseContent = response.content ?? '';

        if (response.type && response.type !== 'assistant') {
          console.warn(
            `LLM generation did not return assistant response. Attempt ${attempts}.`,
          );
          if (attempts >= this.maxAttempts) {
            if (this.raiseError) {
              throw new Error(
                `LLM generation failed after ${attempts} attempts: Did not return assistant response.`,
              );
            } else {
              return { content: '' };
            }
          }
          continue;
        }

        // Validate the string content using shared logic
        lastResult = await this.validateContent(responseContent, session);

        if (lastResult.isValid) {
          return {
            content: responseContent,
            toolCalls: response.toolCalls,
            toolResults: response.toolResults,
            metadata: response.attrs,
            structuredOutput: response.structuredOutput,
          };
        }

        // Handle validation failure
        const isLastAttempt = attempts >= this.maxAttempts;

        if (isLastAttempt) {
          if (this.raiseError) {
            const errorMessage = `Validation failed after ${attempts} attempts: ${lastResult.instruction || ''}`;
            throw new ValidationError(errorMessage);
          } else {
            console.warn(
              `LlmSource: Validation failed after ${attempts} attempts. Returning last generated content.`,
            );
            return {
              content: responseContent,
              toolCalls: response.toolCalls,
              toolResults: response.toolResults,
              metadata: response.attrs,
              structuredOutput: response.structuredOutput,
            };
          }
        } else {
          console.log(
            `Validation attempt ${attempts} failed: ${lastResult?.instruction || 'Invalid input'}. Retrying generation...`,
          );
        }
      } catch (error) {
        if (attempts >= this.maxAttempts) {
          if (this.raiseError) {
            throw error;
          } else {
            return { content: '' };
          }
        }
        console.log(`Generation attempt ${attempts} failed, retrying...`);
      }
    }

    throw new Error(
      `LLM content generation failed unexpectedly after ${this.maxAttempts} attempts.`,
    );
  }

  private async generateWithRuntimeToolLoop(
    session: Session<any, any>,
    runtime: ExecutionRuntimeState<any, any>,
  ) {
    let lastAssistant:
      | {
          type: 'assistant';
          content: string;
          toolCalls?: Array<{
            name: string;
            arguments: Record<string, unknown>;
            id: string;
          }>;
          attrs?: Record<string, unknown>;
          structuredContent?: unknown;
        }
      | undefined;

    for await (const message of generateTextStream(
      session,
      this.options,
      runtime,
    )) {
      if (message.type === 'assistant') {
        lastAssistant = message;
      }
    }

    if (!lastAssistant) {
      throw new Error('LLM generation did not return assistant response.');
    }

    return {
      type: 'assistant',
      content: lastAssistant.content,
      toolCalls: lastAssistant.toolCalls,
      attrs: lastAssistant.attrs,
      structuredOutput: lastAssistant.structuredContent,
    };
  }
}

function isFirstPartyNativeProvider(options: LLMOptions): boolean {
  return (
    (options.provider.type === 'openai' &&
      options.provider.api === 'responses' &&
      options.provider.adapter !== 'ai-sdk') ||
    (options.provider.type === 'anthropic' &&
      options.provider.adapter !== 'ai-sdk') ||
    (options.provider.type === 'google' &&
      options.provider.adapter !== 'ai-sdk')
  );
}

function hasPromptTrailTools(options: LLMOptions): boolean {
  return (
    Object.keys(options.tools ?? {}).length > 0 ||
    (options.capabilities ?? []).some(isPromptTrailTool)
  );
}

/**
 * Convenience factory methods for creating common sources
 */
export namespace Source {
  /** Create LLM source with sensible defaults */
  export function llm(options?: Partial<LLMOptions>): LlmSource {
    return new LlmSource(options);
  }

  /** Reset all LLM call counters (useful for testing) */
  export function resetCallCounters(): void {
    llmCallCounter.clear();
  }

  /** Get current call count for a specific LlmSource instance */
  export function getCallCount(instanceId: string): number {
    return llmCallCounter.get(instanceId) || 0;
  }

  /** Create CLI input source with fluent API */
  export function cli(
    prompt?: string,
    defaultValue?: string,
    options?: ValidationOptions,
  ): CLISource {
    return new CLISource(prompt, defaultValue, options);
  }

  /** Create static literal content source with fluent API */
  export function literal(
    content: string,
    options?: ValidationOptions,
  ): LiteralSource {
    return new LiteralSource(content, options);
  }

  /** Create callback-based source with fluent API */
  export function callback(
    callback: (context: { context?: Vars }) => Promise<string>,
    options?: ValidationOptions,
  ): CallbackSource {
    return new CallbackSource(callback, options);
  }

  /** Create random content source with fluent API */
  export function random(
    contentList: string[],
    options?: ValidationOptions,
  ): RandomSource {
    return new RandomSource(contentList, options);
  }

  /** Create list content source with fluent API */
  export function list(
    contentList: string[],
    options?: ValidationOptions & { loop?: boolean },
  ): ListSource {
    return new ListSource(contentList, options);
  }

  /** Create schema-based source using enhanced LlmSource */
  export function schema<T extends Record<string, unknown>>(
    schema: z.ZodType<T>,
    options?: {
      mode?: SchemaGenerationMode;
      functionName?: string;
      maxAttempts?: number;
      raiseError?: boolean;
      validator?: IValidator;
    } & Partial<LLMOptions>,
  ): LlmSource {
    const {
      mode,
      functionName,
      maxAttempts,
      raiseError,
      validator,
      ...llmOptions
    } = options || {};

    return new LlmSource(llmOptions, {
      validator,
      maxAttempts,
      raiseError,
    }).withSchema(schema, { mode, functionName });
  }
}
