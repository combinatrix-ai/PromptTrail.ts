# PromptTrail Template Visual Builder

The PromptTrail Template Visual Builder is a user-friendly tool that allows you to visually create and edit PromptTrail templates. Build complex prompt templates with a simple interface and automatically generate the corresponding TypeScript code to use in your applications.

## Features

- **Visual Template Builder**: Create and edit prompt templates through an intuitive interface
- **In-place Editing**: Edit template properties directly in the template nodes
- **Hierarchical Visualization**: Easily visualize nested templates with proper parent-child relationships
- **Auto-Generated Code**: View TypeScript code that's automatically generated from your visual template
- **Support for All Template Types**: Create System, User, Assistant, Linear, Loop, and Subroutine templates
- **Type Conversion**: Convert between container types (Linear, Loop, Subroutine) while preserving child templates
- **Multi-line Support**: Add multi-line content to your templates with proper code generation
- **Interactive Testing**: Test your templates directly in the UI with a built-in chat interface

## Usage

### Getting Started

Start with the root template (created automatically) and build your prompt flow by adding child templates:

1. Use the "+" buttons within container templates to add new templates
2. Select the type of template to add (System, User, Assistant, etc.)
3. Templates will be arranged in sequence within their parent container

### Container Templates

- **Linear**: Basic sequence of templates executed in order
- **Loop**: Repeats child templates until an exit condition is met
- **Subroutine**: Reusable template that can be called from other templates

### Template Properties

All template properties can be edited directly in the visual editor:

- **Names**: All container templates have editable names (chatTemplate, linearTemplate1, etc.)
- **System Templates**: Edit the system prompt content
- **User Templates**: Configure description and default values
- **Assistant Templates**: Select model type and add content

### Template Organization

- **Reordering**: Use the ↑ and ↓ buttons to move templates up and down
- **Deleting**: Remove templates with the × button
- **Expanding/Collapsing**: Toggle container views with the +/- buttons

### Converting Template Types

Container templates can be converted between different types:

1. Select the container template
2. Use the type dropdown at the top of the template
3. Select the desired type (Linear, Loop, or Subroutine)

### Generated Code

The right panel shows the TypeScript code generated from your template. This code is ready to use in your PromptTrail applications.

### Session Panel and Testing

The Session Panel allows you to test your templates in real-time:

1. **API Key Configuration**: Enter your OpenAI API key to enable model access
2. **Run Template**: Execute your template to see how it behaves
3. **Interactive Chat**: When a UserTemplate with inputSource is encountered, the input field becomes active, allowing you to provide input
4. **Message Display**: View the conversation history with color-coded messages for system, user, and assistant roles

#### Key Features of the Session Panel

- **Real-time Testing**: Test your templates as you build them
- **Interactive Input**: Provide input when prompted by UserTemplates
- **Visual Feedback**: Clear indication when waiting for user input
- **Error Handling**: Informative error messages when issues occur
- **Seamless Integration**: Works directly with the templates you create in the visual builder

#### Implementation Details

The Session Panel uses several custom components to provide its functionality:

- **CustomSession**: Extends the core Session class to capture messages and update the UI
- **CustomInputSource**: Implements the InputSource interface to handle user input during template execution
- **SessionStore**: Manages the state of the session, including messages, API keys, and model settings

The implementation ensures that:

- System messages are displayed properly
- User input is collected at the right time
- Assistant responses are generated correctly
- Templates without AssistantTemplates still work properly
- The UI provides clear feedback about the current state

## Running the Visual Builder

```bash
cd dogfooding/visualizer
npm install
npm run dev
```

## Template Type Guidelines

- **LinearTemplate**: Can contain any template type
- **LoopTemplate**: Can contain any template type, repeats until exit condition is met
- **SubroutineTemplate**: Can contain any template type, useful for reusable components
- **System Templates**: Typically appear at the top of a container
- **Templates Order**: Templates are executed in the sequence they appear
