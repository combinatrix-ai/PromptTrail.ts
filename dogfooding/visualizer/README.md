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
