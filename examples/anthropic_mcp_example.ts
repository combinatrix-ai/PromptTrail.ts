/**
 * Example of using Anthropic MCP with PromptTrail
 *
 * This example demonstrates how to use the Anthropic Model Context Protocol (MCP)
 * integration with PromptTrail to access external tools and resources.
 *
 * Prerequisites:
 * - An Anthropic API key
 * - An MCP server running (e.g., a GitHub MCP server)
 */
import {
  createSession,
  LinearTemplate,
  type GenerateOptions,
} from '../packages/core/src';

// Replace with your actual API key and MCP server URL
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'your-api-key';
const MCP_SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:8080';

async function main() {
  try {
    // Define generateOptions for Anthropic with MCP integration
    const generateOptions: GenerateOptions = {
      provider: {
        type: 'anthropic',
        apiKey: ANTHROPIC_API_KEY,
        modelName: 'claude-3-5-haiku-latest', // Use the latest Claude model
      },
      temperature: 0.7,
      mcpServers: [
        {
          url: MCP_SERVER_URL,
          name: 'example-mcp-server',
          version: '1.0.0',
        },
      ],
    };

    console.log('Initializing MCP tools...');

    // Create a template that uses the model with MCP tools
    const template = new LinearTemplate()
      .addSystem(
        `You are a helpful assistant with access to external tools and resources.
                 You can use these tools when needed to provide accurate information.`,
      )
      .addUser(
        'What tools do you have access to? Please list them and explain what they do.',
        '',
      )
      .addAssistant({ generateOptions });

    console.log('Executing template...');

    // Execute the template
    const session = await template.execute(createSession());

    // Get the assistant's response
    const response = session.messages[session.messages.length - 1];

    console.log('\nAssistant Response:');
    console.log(response.content);

    // Example of a follow-up question that might use a tool
    const followUpTemplate = new LinearTemplate()
      .addSystem(
        `You are a helpful assistant with access to external tools and resources.
                 You can use these tools when needed to provide accurate information.`,
      )
      .addUser('What tools do you have access to?', '')
      .addAssistant({ generateOptions })
      .addUser(
        'Please use one of your tools to help me with a task. For example, if you have a weather tool, check the weather in San Francisco.',
        '',
      )
      .addAssistant({ generateOptions });

    console.log('\nExecuting follow-up template...');

    // Execute the follow-up template
    const followUpSession = await followUpTemplate.execute(createSession());

    // Get the assistant's response to the follow-up
    const followUpResponse =
      followUpSession.messages[followUpSession.messages.length - 1];

    console.log('\nFollow-up Response:');
    console.log(followUpResponse.content);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the example
main().catch(console.error);
