import { Scenario, Source, createSession } from '@prompttrail/core';
import { tool } from 'ai';
import { z } from 'zod';

/**
 * Autonomous Researcher Example
 *
 * This example shows how the LLM can autonomously decide when it has
 * gathered enough information to answer a question, using the check_goal tool.
 */

// Research tools that return varying amounts of information
const researchTools = {
  searchDocumentation: tool({
    description: 'Search project documentation for information',
    parameters: z.object({
      query: z.string().describe('Search query'),
      depth: z
        .string()
        .describe('Search depth: shallow or deep')
        .default('shallow'),
    }),
    execute: async ({ query, depth = 'shallow' }) => {
      console.log(`\n📚 Searching docs for: "${query}" (${depth})`);

      // Simulate different results based on query
      const results: Record<string, any> = {
        architecture: {
          overview:
            'The system uses a microservices architecture with 5 main services',
          services: [
            'auth-service',
            'api-gateway',
            'data-processor',
            'notification-service',
            'analytics',
          ],
          communication: 'Services communicate via RabbitMQ and REST APIs',
          database: 'PostgreSQL for persistent data, Redis for caching',
        },
        authentication: {
          method: 'JWT-based authentication with refresh tokens',
          flow: '1. User login -> 2. Validate credentials -> 3. Issue JWT + refresh token',
          security:
            'Tokens expire after 15 minutes, refresh tokens after 7 days',
          implementation: 'Located in auth-service/src/jwt.ts',
        },
        api: {
          type: 'RESTful API with OpenAPI specification',
          endpoints: ['/api/v1/users', '/api/v1/products', '/api/v1/orders'],
          authentication:
            'Bearer token required for all endpoints except /health',
          rateLimit: '100 requests per minute per IP',
        },
      };

      // Return more info for deep searches
      if (depth === 'deep' && results[query.toLowerCase()]) {
        return {
          found: true,
          mainInfo: results[query.toLowerCase()],
          relatedTopics: Object.keys(results).filter(
            (k) => k !== query.toLowerCase(),
          ),
          suggestion:
            'Consider exploring related topics for complete understanding',
        };
      }

      return {
        found: !!results[query.toLowerCase()],
        mainInfo:
          results[query.toLowerCase()] || 'No specific documentation found',
        hint: 'Try searching for: ' + Object.keys(results).join(', '),
      };
    },
  }),

  analyzeCodebase: tool({
    description: 'Analyze codebase statistics and structure',
    parameters: z.object({
      aspect: z
        .string()
        .describe(
          'What aspect to analyze: size, languages, dependencies, or structure',
        ),
    }),
    execute: async ({ aspect }) => {
      console.log(`\n🔍 Analyzing codebase: ${aspect}`);

      const analyses = {
        size: {
          totalFiles: 234,
          linesOfCode: 45000,
          testFiles: 89,
          testCoverage: '78%',
        },
        languages: {
          primary: 'TypeScript (65%)',
          secondary: ['JavaScript (20%)', 'Python (10%)', 'Shell (5%)'],
          frameworks: ['Node.js', 'Express', 'React', 'FastAPI'],
        },
        dependencies: {
          production: 45,
          development: 23,
          critical: ['express@4.18.0', 'jsonwebtoken@9.0.0', 'pg@8.11.0'],
          outdated: 5,
        },
        structure: {
          pattern: 'Monorepo with workspaces',
          mainFolders: ['services/', 'packages/', 'apps/', 'docs/'],
          buildSystem: 'Turborepo with pnpm workspaces',
          cicd: 'GitHub Actions with automatic deployments',
        },
      };

      return {
        aspect,
        data: analyses[aspect],
        completeness: 'high',
        lastUpdated: new Date().toISOString(),
      };
    },
  }),

  investigateSpecific: tool({
    description: 'Deep dive into a specific file or component',
    parameters: z.object({
      target: z
        .string()
        .describe('Specific file, class, or component to investigate'),
      detail: z
        .string()
        .describe('Level of detail: summary or full')
        .default('summary'),
    }),
    execute: async ({ target, detail = 'summary' }) => {
      console.log(`\n🎯 Investigating: ${target} (${detail})`);

      // Simulate investigation results
      if (target.includes('auth') || target.includes('jwt')) {
        return {
          found: true,
          type: 'Authentication Module',
          location: 'services/auth-service/src/jwt.ts',
          purpose: 'Handles JWT token generation and validation',
          details:
            detail === 'full'
              ? {
                  methods: [
                    'generateToken',
                    'validateToken',
                    'refreshToken',
                    'revokeToken',
                  ],
                  dependencies: ['jsonwebtoken', 'bcrypt', 'redis'],
                  configuration: 'Uses RS256 algorithm with key rotation',
                  tests: 'Full test coverage in jwt.test.ts',
                  recentChanges:
                    'Updated 2 days ago to fix token expiration bug',
                }
              : 'Basic JWT implementation with standard security practices',
        };
      }

      return {
        found: false,
        suggestion: `Could not find specific details about "${target}". Try searching documentation first.`,
      };
    },
  }),
};

async function createAutonomousResearcher() {
  console.log('🧠 Autonomous Research Agent\n');
  console.log(
    'This agent will explore until it feels it has enough information.\n',
  );

  // Configure LLM source
  const llmSource = Source.llm()
    .openai()
    .apiKey(process.env.OPENAI_API_KEY || '')
    .model('gpt-4.1')
    .temperature(0.7);

  const scenario = Scenario.system(
    'You are a code research assistant. Help users understand codebases by researching and explaining code.',
    {
      tools: researchTools,
      llmSource: llmSource,
    },
  )

    // Get the research question
    .step("Use ask_user to get the user's question.", {
      allow_interaction: true,
      max_attempts: 2,
    })

    // Research phase
    .step(
      "Research the user's question. Use tools 2-3 times, then call check_goal.",
      {
        max_attempts: 6,
      },
    )

    // Provide answer
    .step('Provide a comprehensive answer based on your research.', {
      max_attempts: 2,
    })

    // Follow-up
    .step('Ask if they want more details.', {
      allow_interaction: true,
      max_attempts: 1,
    });

  return scenario;
}

// Example showing how the agent tracks its own research progress
async function runAutonomousResearch() {
  // Check for API key
  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ Please set OPENAI_API_KEY environment variable');
    console.error(
      '   Example: OPENAI_API_KEY=sk-... bun run examples/autonomous_researcher.ts\n',
    );
    console.error(
      '   Or use the mock example: bun run examples/scenario_demo.ts',
    );
    process.exit(1);
  }

  try {
    const scenario = await createAutonomousResearcher();

    // Create session with research tracking
    const session = createSession({
      print: true,
      context: {
        researchStartTime: Date.now(),
        researchDepth: 0,
        topicsExplored: [],
      },
    });

    console.log(
      '💡 Tip: Ask about authentication, API structure, or system architecture.\n',
    );

    // Execute the research
    const finalSession = await scenario.execute(session);

    // Show research statistics
    const duration = Date.now() - finalSession.getVar('researchStartTime');
    const assistantMessages = finalSession.getMessagesByType('assistant');
    const toolCalls = assistantMessages.flatMap((m) => m.toolCalls || []);

    console.log('\n📊 Research Statistics:');
    console.log(`⏱️  Duration: ${Math.round(duration / 1000)}s`);
    console.log(`🤖 Assistant turns: ${assistantMessages.length}`);
    console.log(`🔧 Tool calls made: ${toolCalls.length}`);
    console.log(
      `📚 Different tools used: ${new Set(toolCalls.map((tc) => tc.name)).size}`,
    );

    // Show tool usage breakdown
    const toolUsage = toolCalls.reduce(
      (acc, tc) => {
        acc[tc.name] = (acc[tc.name] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    console.log('\n🔧 Tool Usage:');
    Object.entries(toolUsage).forEach(([tool, count]) => {
      console.log(`  - ${tool}: ${count} calls`);
    });
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

// Alternative: Research with minimum requirements
async function runWithMinimumRequirements() {
  console.log('📋 Research with Minimum Requirements\n');

  // Track what has been researched
  const researchTracker = {
    hasOverview: false,
    hasSpecificDetails: false,
    hasCodeExamples: false,
    toolsUsed: new Set<string>(),
    callCount: 0,
  };

  // Create tracking tools
  const trackingTools = Object.entries(researchTools).reduce(
    (acc, [name, tool]) => {
      acc[name] = tool({
        ...tool,
        execute: async (params: any) => {
          researchTracker.callCount++;
          researchTracker.toolsUsed.add(name);

          const result = await tool.execute(params);

          // Update tracking based on results
          if (name === 'searchDocumentation' && result.found) {
            researchTracker.hasOverview = true;
          }
          if (name === 'investigateSpecific' && result.found) {
            researchTracker.hasSpecificDetails = true;
            researchTracker.hasCodeExamples = true;
          }

          return result;
        },
      });
      return acc;
    },
    {} as any,
  );

  const scenario = Scenario.system(
    'You are a thorough researcher. Explore multiple aspects before concluding.',
    { tools: trackingTools },
  )
    .interact('What would you like to research?')
    .step('Research comprehensively', {
      max_attempts: 25,
      is_satisfied: (session) => {
        // Require minimum research depth
        const meetsMinimum =
          researchTracker.hasOverview &&
          researchTracker.hasSpecificDetails &&
          researchTracker.toolsUsed.size >= 2 &&
          researchTracker.callCount >= 5;

        if (meetsMinimum) {
          console.log('\n✅ Minimum research requirements met!');
          return true;
        }

        // Also check if LLM indicates completion
        const lastMessage = session.getLastMessage();
        if (
          lastMessage?.toolCalls?.some(
            (tc) => tc.name === 'check_goal' && tc.result?.is_satisfied,
          )
        ) {
          if (!meetsMinimum) {
            console.log(
              "\n⚠️  LLM thinks it's done but minimum requirements not met. Continuing...",
            );
            return false;
          }
          return true;
        }

        return false;
      },
    })
    .process('Provide comprehensive findings');

  await scenario.execute(createSession({ print: true }));

  console.log('\n📈 Final Research Depth:');
  console.log(`  - Has Overview: ${researchTracker.hasOverview ? '✓' : '✗'}`);
  console.log(
    `  - Has Details: ${researchTracker.hasSpecificDetails ? '✓' : '✗'}`,
  );
  console.log(
    `  - Has Examples: ${researchTracker.hasCodeExamples ? '✓' : '✗'}`,
  );
  console.log(`  - Tools Used: ${researchTracker.toolsUsed.size}`);
  console.log(`  - Total Calls: ${researchTracker.callCount}`);
}

// Run the example
if (require.main === module) {
  // Choose which example to run:

  runAutonomousResearch().catch(console.error);
  // runWithMinimumRequirements().catch(console.error);
}

export {
  createAutonomousResearcher,
  runAutonomousResearch,
  runWithMinimumRequirements,
};
