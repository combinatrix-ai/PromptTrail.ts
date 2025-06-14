import type { Tool as AiSdkTool } from 'ai';
import { bash } from './bash';
import { fileRead } from './file-read';
import { fileEdit } from './file-edit';
import { globSearch } from './glob';
import { grep } from './grep';
import { ls } from './ls';
import { memoryRead } from './memory-read';
import { memoryWrite } from './memory-write';
import { think } from './think';
import { agent } from './agent';

/**
 * Default tools provided by PromptTrail.ts
 * These tools offer common functionality for file operations, shell commands, and code editing
 */
export const defaultTools = {
  bash,
  fileRead,
  fileEdit,
  globSearch,
  grep,
  ls,
  memoryRead,
  memoryWrite,
  think,
  agent,
} as const;

/**
 * Get all default tools as an array
 * Useful for passing to AI SDK generation functions
 */
export function getAllDefaultTools(): AiSdkTool[] {
  return Object.values(defaultTools);
}

/**
 * Get specific default tools by name
 * @param toolNames Array of tool names to include
 * @returns Array of selected tools
 */
export function getDefaultTools(toolNames: (keyof typeof defaultTools)[]): AiSdkTool[] {
  return toolNames.map(name => defaultTools[name]);
}

/**
 * Tool categories for easier selection
 */
export const toolCategories = {
  /** File system operations */
  fileSystem: [defaultTools.fileRead, defaultTools.fileEdit, defaultTools.ls],
  
  /** Search and discovery */
  search: [defaultTools.globSearch, defaultTools.grep],
  
  /** Shell operations */
  shell: [defaultTools.bash],
  
  /** Memory and context management */
  memory: [defaultTools.memoryRead, defaultTools.memoryWrite],
  
  /** Reasoning and agent operations */
  reasoning: [defaultTools.think, defaultTools.agent],
  
  /** Read-only tools (safe for any environment) */
  readOnly: [defaultTools.fileRead, defaultTools.globSearch, defaultTools.grep, defaultTools.ls, defaultTools.memoryRead, defaultTools.think],
  
  /** Write tools (require careful permission management) */
  write: [defaultTools.fileEdit, defaultTools.bash, defaultTools.memoryWrite, defaultTools.agent],
} as const;

/**
 * Get tools by category
 * @param category The category of tools to get
 * @returns Array of tools in the specified category
 */
export function getToolsByCategory(category: keyof typeof toolCategories): AiSdkTool[] {
  return [...toolCategories[category]];
}