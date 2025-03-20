import {
  AIProvider,
  AISDKModelConfig,
  AISDKModel,
} from '../model/ai_sdk_model';
import type { OpenAIConfig } from '../model/openai/types';
import type { AnthropicConfig } from '../model/anthropic/types';

/**
 * Migrate from OpenAI model to AI SDK model
 */
export function migrateOpenAIToAISDK(config: OpenAIConfig): AISDKModel {
  const aiSdkConfig: AISDKModelConfig = {
    provider: AIProvider.OPENAI,
    apiKey: config.apiKey,
    apiBase: config.apiBase,
    organizationId: config.organizationId,
    modelName: config.modelName,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    tools: config.tools,
  };

  return new AISDKModel(aiSdkConfig);
}

/**
 * Migrate from Anthropic model to AI SDK model
 */
export function migrateAnthropicToAISDK(config: AnthropicConfig): AISDKModel {
  const aiSdkConfig: AISDKModelConfig = {
    provider: AIProvider.ANTHROPIC,
    apiKey: config.apiKey,
    apiBase: config.apiBase,
    modelName: config.modelName,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    tools: config.tools,
  };

  return new AISDKModel(aiSdkConfig);
}
