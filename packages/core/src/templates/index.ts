// Export all from basic.ts for backward compatibility
export * from './basic';

// Export composed templates
export * from './composed';

// Export content source based templates with renamed exports
export {
  ContentSourceTemplate,
  MessageTemplate,
  SystemTemplate as ContentSourceSystemTemplate,
  UserTemplate as ContentSourceUserTemplate,
  AssistantTemplate as ContentSourceAssistantTemplate,
  ToolResultTemplate as ContentSourceToolResultTemplate,
} from './message_template';
