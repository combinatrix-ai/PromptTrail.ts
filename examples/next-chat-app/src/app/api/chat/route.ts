import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { CoreMessage, streamText } from 'ai';
import { NextResponse } from 'next/server';
import {
  Agent,
  createSession,
  Vars as PromptTrailContext,
  Message as PromptTrailMessage,
  System,
} from '../../../../../../packages/core/src';

// Define a type for our session context data (plain object)
interface ChaTVarsData {
  codeContext: string;
}

// This is the branded context type that will be used by Session and Agent
type BrandedChaTVars = PromptTrailContext<ChaTVarsData>;

// Ensure the GOOGLE_API_KEY is set in your environment variables
// The @ai-sdk/google provider defaults to GOOGLE_GENERATIVE_AI_API_KEY,
// but we are checking for GOOGLE_API_KEY and passing it explicitly.
if (!process.env.GOOGLE_API_KEY) {
  throw new Error(
    'Missing GOOGLE_API_KEY environment variable. Note: @ai-sdk/google defaults to GOOGLE_GENERATIVE_AI_API_KEY.',
  );
}

// Instantiate the Google provider correctly
const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });

export async function POST(req: Request) {
  try {
    const { messages: incomingMessages, codeContext } = await req.json();

    // Let ptSession type be inferred. It will be Session<BrandedChaTVars, Metadata<unknown>>
    let ptSession = createSession({
      // Pass plain data type here, let createSession infer and handle branding
      context: { codeContext: codeContext || 'No code context provided.' },
    });

    // Agent should be typed with the BrandedChaTVars
    // The System template will use 'codeContext' from ptSession.context
    const trail = Agent.create<BrandedChaTVars>().add(
      new System(
        'You are a helpful AI assistant that discusses the provided code context. Code context: ${codeContext}',
      ),
    );
    // The execute method of Agent<BrandedChaTVars> will expect/return Session<BrandedChaTVars, ...>
    console.log('[Chat API] Received codeContext:', codeContext); // Log received context
    ptSession = await trail.execute(ptSession);

    if (ptSession.messages.length > 0) {
      console.log(
        '[Chat API] First message from PromptTrail:',
        ptSession.messages[0].content,
      ); // Log first generated message
    }

    if (incomingMessages && incomingMessages.length > 0) {
      for (const msg of incomingMessages as CoreMessage[]) {
        ptSession = ptSession.addMessage({
          type: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content as string,
        });
      }
    }

    // Explicitly type ptMsg if Message is now available and resolves the 'any' type
    const messagesForApi: CoreMessage[] = ptSession.messages.map(
      (ptMsg: PromptTrailMessage) => {
        const role =
          ptMsg.type === 'system'
            ? 'system'
            : ptMsg.type === 'user'
              ? 'user'
              : 'assistant'; // Assuming 'tool_result' is not directly mapped here
        let content = ptMsg.content || '';
        if (ptMsg.structuredContent) {
          content += '\n' + JSON.stringify(ptMsg.structuredContent);
        }
        return {
          role: role,
          content: content,
        };
      },
    );

    const result = await streamText({
      model: google('models/gemini-1.5-flash-latest'), // Using the provider instance to get a model
      messages: messagesForApi,
    });

    return result.toDataStreamResponse();
  } catch (error) {
    console.error('[Chat API Error]', error);
    const errorMessage =
      error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
