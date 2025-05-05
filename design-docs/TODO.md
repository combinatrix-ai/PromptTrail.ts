- Support caching
- Supprot multiple Source output types
- Use same metadata/context throughout the template
  - No updateContext and updateMetadata to include non prefined fields
  - No separate metadata and context for subroutines
- ModelOutput.metadata is not decided
- We need `walk` method for templates, because Conditional and Composite templates both have children
- createContext and createSession should be more flexible
  - Define SessionLike and ContextLike object interface and allow to pass such objects
  - allow this: const session = await chat.execute({print: true})
- createSession is too difficult
  - e.g. in Transform
  - // TODO: Making new Session is too difficult
    createSession({
    context: session.context,
    messages: session.messages.map((message) => {
    message.metadata = updateMetadata(
    message.metadata,
    'timestamp',
    date,
    );
    return message;
    }),
    print: session.print,
    });
    return session.setContextValue('username', 'Bob');
- Tests are redundant and useless
