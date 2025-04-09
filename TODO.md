- Hierarchial GenerateOptions
  - If generateoptions of AssistantTemplate is nonexistent, use parent one
- Object initialization
  - Use type based one?
  - Shoul accept GenerateOptions on LoopTemplate
- SchemaTemplate
  - Use aiSdk tool
- UserTemplate
  - default?: string should be InputSource attribute
  - description: string should be CLIInputSource attribute
  - onInput? and maybe onChange? should be InputSource attribute
  - validate? should be CLIInputSource attribute
    - bonus: validate? accept same thing as guradrail object
  - => This is difficult because InputSource will be passed later

this.template = Agent()
.addSystem(
'You are a coding agent that can execute shell commands and manipulate files. Use the available tools to help users accomplish their tasks.',
)
.addUser()
.addAssistant()
.use(tools)
.use(ReactEventRegister)
.print()

this.template.execute(
generateOptions, // default
inputSource // default
tools,
middlewares
)

this.template = Agent()
.addSystem(
'You are a coding agent that can execute shell commands and manipulate files. Use the available tools to help users accomplish their tasks.',
)
.addUser( new CLIInputSource)
.add( new AssistantTemplate().use(tool2))
.use(tools)
.use(ReactEventRegister)
.print()
