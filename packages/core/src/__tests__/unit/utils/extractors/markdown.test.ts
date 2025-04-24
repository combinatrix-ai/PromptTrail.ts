import { describe, it, expect } from 'vitest';
import { createSession } from '../../../../session';
import { extractMarkdown } from '../../../../utils/markdown_extractor';
import { createMessage } from '../../../utils';

describe('Markdown Extractor', () => {
  it('should extract markdown headings', () => async () => {
    // Create a session with a message containing markdown headings
    const session = createSession({
      messages: [
        createMessage(
          'assistant',
          `
Here's the information you requested:

## Summary
This is a summary of the content.

## Details
These are the details of the content.

## Conclusion
This is the conclusion.
        `,
        ),
      ],
    });

    // Extract the markdown headings
    const transformer = extractMarkdown({
      headingMap: {
        Summary: 'summary',
        Details: 'details',
        Conclusion: 'conclusion',
      },
    });

    // Apply the transformer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transformedSession = await transformer.transform(session);

    // Check that the context was updated correctly
    expect(transformedSession.getContextValue('summary')).toBe(
      'This is a summary of the content.',
    );
    expect(transformedSession.getContextValue('details')).toBe(
      'These are the details of the content.',
    );
    expect(transformedSession.getContextValue('conclusion')).toBe(
      'This is the conclusion.',
    );
  });

  it('should extract code blocks', () => async () => {
    // Create a session with a message containing code blocks
    const session = createSession({
      messages: [
        createMessage(
          'assistant',
          `
Here's the code you requested:

\`\`\`typescript
function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
\`\`\`

And here's an example in Python:

\`\`\`python
def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)
\`\`\`
        `,
        ),
      ],
    });

    // Extract the code blocks
    const transformer = extractMarkdown({
      codeBlockMap: {
        typescript: 'tsCode',
        python: 'pyCode',
      },
    });

    // Apply the transformer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transformedSession = await transformer.transform(session);

    // Check that the context was updated correctly
    expect(transformedSession.getContextValue('tsCode')).toBe(
      'function factorial(n: number): number {\n  if (n <= 1) return 1;\n  return n * factorial(n - 1);\n}',
    );
    expect(transformedSession.getContextValue('pyCode')).toBe(
      'def factorial(n):\n    if n <= 1:\n        return 1\n    return n * factorial(n - 1)',
    );
  });

  it('should extract both headings and code blocks', () => async () => {
    // Create a session with a message containing both headings and code blocks
    const session = createSession({
      messages: [
        createMessage(
          'assistant',
          `
## Factorial Function

The factorial function is a mathematical function that multiplies a number by all the positive integers less than it.

\`\`\`typescript
function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
\`\`\`

## Usage Example

Here's how you can use the factorial function:

\`\`\`typescript
console.log(factorial(5)); // 120
\`\`\`
        `,
        ),
      ],
    });

    // Extract both headings and code blocks
    const transformer = extractMarkdown({
      headingMap: {
        'Factorial Function': 'explanation',
        'Usage Example': 'usage',
      },
      codeBlockMap: {
        typescript: 'code',
      },
    });

    // Apply the transformer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transformedSession = await transformer.transform(session);

    // Check that the context was updated correctly
    expect(transformedSession.getContextValue('explanation')).toContain(
      'The factorial function is a mathematical function',
    );
    expect(transformedSession.getContextValue('usage')).toContain(
      "Here's how you can use the factorial function:",
    );

    // For code blocks, it should extract the last matching code block
    expect(transformedSession.getContextValue('code')).toBe(
      'console.log(factorial(5)); // 120',
    );
  });

  it('should filter by message type', () => async () => {
    // Create a session with multiple message types
    const session = createSession({
      messages: [
        createMessage(
          'user',
          `
## User Heading
User content
\`\`\`typescript
const userCode = 'user';
\`\`\`
        `,
        ),
        createMessage(
          'assistant',
          `
## Assistant Heading
Assistant content
\`\`\`typescript
const assistantCode = 'assistant';
\`\`\`
        `,
        ),
      ],
    });

    // Extract only from user messages
    const userTransformer = extractMarkdown({
      messageTypes: ['user'],
      headingMap: {
        'User Heading': 'userHeading',
        'Assistant Heading': 'assistantHeading',
      },
      codeBlockMap: {
        typescript: 'code',
      },
    });

    // Apply the transformer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userTransformedSession = await userTransformer.transform(session);

    // Check that only user content was extracted
    expect(userTransformedSession.getContextValue('userHeading')).toBe(
      'User content',
    );
    expect(
      userTransformedSession.getContextValue('assistantHeading'),
    ).toBeUndefined();
    expect(userTransformedSession.getContextValue('code')).toBe(
      "const userCode = 'user';",
    );

    // Extract only from assistant messages
    const assistantTransformer = extractMarkdown({
      messageTypes: ['assistant'],
      headingMap: {
        'User Heading': 'userHeading',
        'Assistant Heading': 'assistantHeading',
      },
      codeBlockMap: {
        typescript: 'code',
      },
    });

    // Apply the transformer

    const assistantTransformedSession = assistantTransformer.transform(
      session,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    );

    // Check that only assistant content was extracted
    expect(
      assistantTransformedSession.getContextValue('userHeading'),
    ).toBeUndefined();
    expect(
      assistantTransformedSession.getContextValue('assistantHeading'),
    ).toBe('Assistant content');
    expect(assistantTransformedSession.getContextValue('code')).toBe(
      "const assistantCode = 'assistant';",
    );
  });
});
