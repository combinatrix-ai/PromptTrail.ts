import { describe, it, expect } from 'vitest';
import { createSession } from '../../../../session';
import { extractPattern } from '../../../../utils/pattern_extractor';

describe('Pattern Extractor', () => {
  it('should extract content using regex patterns', async () => {
    // Create a session with a message containing patterns to extract
    const session = createSession({
      messages: [
        {
          type: 'assistant',
          content: `
Here's the information you requested:

API Endpoint: https://api.example.com/v1/users
Authentication: Bearer token
Rate Limit: 100 requests per minute
`,
        },
      ],
    });

    // Extract using regex patterns
    const transformer = extractPattern({
      pattern: /API Endpoint: (.+)/,
      key: 'apiEndpoint',
    });

    // Apply the transformer
    const transformedSession = await transformer.transform(session);

    // Check that the context was updated correctly
    expect(transformedSession.getContextValue('apiEndpoint')).toBe(
      'https://api.example.com/v1/users',
    );
  });

  it('should apply transformation functions', () => async () => {
    // Create a session with a message containing numeric data
    const session = createSession({
      messages: [
        {
          type: 'assistant',
          content: `
The analysis results:

Success rate: 95.5%
Error count: 42
Average response time: 120ms
        `,
        },
      ],
    });

    // Extract and transform numeric data
    const transformer = extractPattern({
      pattern: /Error count: (\d+)/,
      key: 'errorCount',
      transform: (value) => parseInt(value, 10),
    });

    // Apply the transformer
    const transformedSession = await transformer.transform(session);

    // Check that the context was updated correctly with the transformed value
    expect(transformedSession.getContextValue('errorCount')).toBe(42);
    expect(typeof transformedSession.getContextValue('errorCount')).toBe('number');
  });

  it('should extract multiple patterns', async () => {
    // Create a session with a message containing multiple patterns
    const session = createSession({
      messages: [
        {
          type: 'assistant',
          content: `
Server Information:
- Hostname: server-01.example.com
- IP Address: 192.168.1.100
- Status: Running
- Uptime: 99.99%
        `,
        },
      ],
    });

    // Extract multiple patterns
    const transformer = extractPattern([
      {
        pattern: /Hostname: (.+)/,
        key: 'hostname',
      },
      {
        pattern: /IP Address: (.+)/,
        key: 'ipAddress',
      },
      {
        pattern: /Status: (.+)/,
        key: 'status',
      },
      {
        pattern: /Uptime: (.+)/,
        key: 'uptime',
        transform: (value) => parseFloat(value.replace('%', '')) / 100,
      },
    ]);

    // Apply the transformer
    const transformedSession = await transformer.transform(session);

    // Check that the context was updated correctly
    expect(transformedSession.getContextValue('hostname')).toBe(
      'server-01.example.com',
    );
    expect(transformedSession.getContextValue('ipAddress')).toBe('192.168.1.100');
    expect(transformedSession.getContextValue('status')).toBe('Running');
    // Use toBeCloseTo for floating point comparisons to avoid precision issues
    expect(transformedSession.getContextValue('uptime')).toBeCloseTo(0.9999, 4);
  });

  it('should use default values when no match is found', () => async () => {
    // Create a session with a message that doesn't contain the pattern
    const session = createSession({
      messages: [
        {
          type: 'assistant',
          content: `
This message doesn't contain the pattern we're looking for.
        `,
        },
      ],
    });

    // Extract with default value
    const transformer = extractPattern({
      pattern: /API Key: (.+)/,
      key: 'apiKey',
      defaultValue: 'no-key-found',
    });

    // Apply the transformer
    const transformedSession = await transformer.transform(session);

    // Check that the default value was used
    expect(transformedSession.getContextValue('apiKey')).toBe('no-key-found');
  });

  it('should filter by message type', () => async () => {
    // Create a session with multiple message types
    const session = createSession({
      messages: [
        {
          type: 'user',
          content: 'My API key is: user-api-key-123',
        },
        {
          type: 'assistant',
          content: 'Your API key is: assistant-api-key-456',
        },
      ],
    });

    // Extract only from user messages
    const userTransformer = extractPattern({
      pattern: /API key is: (.+)/,
      key: 'apiKey',
      messageTypes: ['user'],
    });

    // Apply the transformer
    const userTransformedSession = await userTransformer.transform(session);

    // Check that only user content was extracted
    expect(userTransformedSession.getContextValue('apiKey')).toBe(
      'user-api-key-123',
    );

    // Extract only from assistant messages
    const assistantTransformer = extractPattern({
      pattern: /API key is: (.+)/,
      key: 'apiKey',
      messageTypes: ['assistant'],
    });

    // Apply the transformer

    const assistantTransformedSession = await assistantTransformer.transform(
      session,
    );

    // Check that only assistant content was extracted
    expect(assistantTransformedSession.getContextValue('apiKey')).toBe(
      'assistant-api-key-456',
    );
  });

  it('should use the full match if no capture group is provided', () => async () => {
    // Create a session with a message containing a pattern
    const session = createSession({
      messages: [
        {
          type: 'assistant',
          content: 'The error code is E12345',
        },
      ],
    });

    // Extract using a pattern without capture groups
    const transformer = extractPattern({
      pattern: /E\d{5}/,
      key: 'errorCode',
    });

    // Apply the transformer
    const transformedSession = await transformer.transform(session);

    // Check that the full match was used
    expect(transformedSession.getContextValue('errorCode')).toBe('E12345');
  });
});
