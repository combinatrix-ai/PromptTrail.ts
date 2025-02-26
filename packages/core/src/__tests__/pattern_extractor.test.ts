import { describe, it, expect } from 'vitest';
import { createSession } from '../session';
import { extractPattern } from '../utils/pattern_extractor';
import { createMessage } from './utils';

describe('Pattern Extractor', () => {
  it('should extract content using regex patterns', () => {
    // Create a session with a message containing patterns to extract
    const session = createSession({
      messages: [
        createMessage(
          'assistant',
          `
Here's the information you requested:

API Endpoint: https://api.example.com/v1/users
Authentication: Bearer token
Rate Limit: 100 requests per minute
        `,
        ),
      ],
    });

    // Extract using regex patterns
    const transformer = extractPattern({
      pattern: /API Endpoint: (.+)/,
      key: 'apiEndpoint',
    });

    // Apply the transformer
    const transformedSession = transformer.transform(session) as any;

    // Check that the metadata was updated correctly
    expect(transformedSession.metadata.get('apiEndpoint')).toBe(
      'https://api.example.com/v1/users',
    );
  });

  it('should apply transformation functions', () => {
    // Create a session with a message containing numeric data
    const session = createSession({
      messages: [
        createMessage(
          'assistant',
          `
The analysis results:

Success rate: 95.5%
Error count: 42
Average response time: 120ms
        `,
        ),
      ],
    });

    // Extract and transform numeric data
    const transformer = extractPattern({
      pattern: /Error count: (\d+)/,
      key: 'errorCount',
      transform: (value) => parseInt(value, 10),
    });

    // Apply the transformer
    const transformedSession = transformer.transform(session) as any;

    // Check that the metadata was updated correctly with the transformed value
    expect(transformedSession.metadata.get('errorCount')).toBe(42);
    expect(typeof transformedSession.metadata.get('errorCount')).toBe('number');
  });

  it('should extract multiple patterns', () => {
    // Create a session with a message containing multiple patterns
    const session = createSession({
      messages: [
        createMessage(
          'assistant',
          `
Server Information:
- Hostname: server-01.example.com
- IP Address: 192.168.1.100
- Status: Running
- Uptime: 99.99%
        `,
        ),
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
    const transformedSession = transformer.transform(session) as any;

    // Check that the metadata was updated correctly
    expect(transformedSession.metadata.get('hostname')).toBe(
      'server-01.example.com',
    );
    expect(transformedSession.metadata.get('ipAddress')).toBe('192.168.1.100');
    expect(transformedSession.metadata.get('status')).toBe('Running');
    // Use toBeCloseTo for floating point comparisons to avoid precision issues
    expect(transformedSession.metadata.get('uptime')).toBeCloseTo(0.9999, 4);
  });

  it('should use default values when no match is found', () => {
    // Create a session with a message that doesn't contain the pattern
    const session = createSession({
      messages: [
        createMessage(
          'assistant',
          `
This message doesn't contain the pattern we're looking for.
        `,
        ),
      ],
    });

    // Extract with default value
    const transformer = extractPattern({
      pattern: /API Key: (.+)/,
      key: 'apiKey',
      defaultValue: 'no-key-found',
    });

    // Apply the transformer
    const transformedSession = transformer.transform(session) as any;

    // Check that the default value was used
    expect(transformedSession.metadata.get('apiKey')).toBe('no-key-found');
  });

  it('should filter by message type', () => {
    // Create a session with multiple message types
    const session = createSession({
      messages: [
        createMessage('user', 'My API key is: user-api-key-123'),
        createMessage('assistant', 'Your API key is: assistant-api-key-456'),
      ],
    });

    // Extract only from user messages
    const userTransformer = extractPattern({
      pattern: /API key is: (.+)/,
      key: 'apiKey',
      messageTypes: ['user'],
    });

    // Apply the transformer
    const userTransformedSession = userTransformer.transform(session) as any;

    // Check that only user content was extracted
    expect(userTransformedSession.metadata.get('apiKey')).toBe(
      'user-api-key-123',
    );

    // Extract only from assistant messages
    const assistantTransformer = extractPattern({
      pattern: /API key is: (.+)/,
      key: 'apiKey',
      messageTypes: ['assistant'],
    });

    // Apply the transformer
    const assistantTransformedSession = assistantTransformer.transform(
      session,
    ) as any;

    // Check that only assistant content was extracted
    expect(assistantTransformedSession.metadata.get('apiKey')).toBe(
      'assistant-api-key-456',
    );
  });

  it('should use the full match if no capture group is provided', () => {
    // Create a session with a message containing a pattern
    const session = createSession({
      messages: [createMessage('assistant', 'The error code is E12345')],
    });

    // Extract using a pattern without capture groups
    const transformer = extractPattern({
      pattern: /E\d{5}/,
      key: 'errorCode',
    });

    // Apply the transformer
    const transformedSession = transformer.transform(session) as any;

    // Check that the full match was used
    expect(transformedSession.metadata.get('errorCode')).toBe('E12345');
  });
});
