// Export all from basic.ts for backward compatibility
export * from './basic';

// Export composed templates
export * from './composed';

// Export content source based templates
export {
  ContentSourceTemplate,
  MessageTemplate,
  ContentSourceSystemTemplate,
  ContentSourceUserTemplate,
  ContentSourceAssistantTemplate,
  ToolResultTemplate,
  // Also export the original names for backward compatibility
  SystemTemplate,
  UserTemplate,
  AssistantTemplate,
} from './message_template';
