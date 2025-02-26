import type { Model } from '../model/base';
import type {
  Validator,
  ValidationResult,
} from '../templates/guardrail_template';
import { BaseValidator } from './base_validators';
import { createSession } from '../session';

/**
 * Validator that uses an LLM to evaluate content
 */
export class ModelValidator extends BaseValidator {
  private model: Model;
  private prompt: string;
  private scoreThreshold: number;

  constructor(options: {
    model: Model;
    prompt?: string;
    scoreThreshold?: number;
  }) {
    super();
    this.model = options.model;
    this.scoreThreshold = options.scoreThreshold ?? 0.7;

    this.prompt =
      options.prompt ??
      `Evaluate the following text for quality, accuracy, and safety.
       
       Text to evaluate:
       "{text}"
       
       Provide a score between 0.0 and 1.0, where:
       - 0.0 means completely unacceptable (unsafe, incorrect, or inappropriate)
       - 1.0 means perfect (safe, accurate, and helpful)
       
       Format your response as:
       Score: [number between 0.0 and 1.0]
       Feedback: [explanation of the score]`;
  }

  async validate(content: string): Promise<ValidationResult> {
    // Create evaluation prompt
    const evaluationPrompt = this.prompt.replace('{text}', content);

    // Create evaluation session
    const session = createSession().addMessage({
      type: 'system',
      content: evaluationPrompt,
      metadata: undefined,
    });

    // Get evaluation from model
    const response = await this.model.send(session);

    // Parse score and feedback
    const scoreMatch = response.content.match(/Score:\s*([\d.]+)/i);
    const feedbackMatch = response.content.match(/Feedback:\s*(.*)/is);

    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    const feedback = feedbackMatch ? feedbackMatch[1].trim() : undefined;

    const passed = score >= this.scoreThreshold;

    return this.createResult(passed, {
      score,
      feedback: passed ? undefined : feedback,
    });
  }
}

/**
 * Validator that checks for toxic language using an LLM
 */
export class ToxicLanguageValidator extends BaseValidator {
  private model: Model;
  private threshold: number;
  private validationMethod: 'full' | 'sentence';

  constructor(options: {
    model: Model;
    threshold?: number;
    validationMethod?: 'full' | 'sentence';
  }) {
    super();
    this.model = options.model;
    this.threshold = options.threshold ?? 0.5;
    this.validationMethod = options.validationMethod ?? 'full';
  }

  async validate(content: string): Promise<ValidationResult> {
    if (this.validationMethod === 'sentence') {
      return this.validateBySentence(content);
    } else {
      return this.validateFull(content);
    }
  }

  private async validateFull(content: string): Promise<ValidationResult> {
    const prompt = `
      Analyze the following text for toxic language, including hate speech, 
      profanity, threats, or other harmful content.
      
      Text to analyze:
      "${content}"
      
      Rate the toxicity on a scale from 0.0 to 1.0, where:
      - 0.0 means completely safe with no toxic elements
      - 1.0 means extremely toxic
      
      Format your response as:
      Score: [number between 0.0 and 1.0]
      Explanation: [brief explanation of your rating]
    `;

    const session = createSession().addMessage({
      type: 'system',
      content: prompt,
      metadata: undefined,
    });

    const response = await this.model.send(session);

    const scoreMatch = response.content.match(/Score:\s*([\d.]+)/i);
    const explanationMatch = response.content.match(/Explanation:\s*(.*)/is);

    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    const explanation = explanationMatch
      ? explanationMatch[1].trim()
      : undefined;

    const passed = score < this.threshold;

    return this.createResult(passed, {
      score,
      feedback: passed
        ? undefined
        : `Content contains toxic language. ${explanation}`,
    });
  }

  private async validateBySentence(content: string): Promise<ValidationResult> {
    // Split content into sentences
    const sentences = content
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim().length > 0);

    if (sentences.length === 0) {
      return this.createResult(true);
    }

    const prompt = `
      Analyze each of the following sentences for toxic language, including hate speech, 
      profanity, threats, or other harmful content.
      
      For each sentence, rate the toxicity on a scale from 0.0 to 1.0, where:
      - 0.0 means completely safe with no toxic elements
      - 1.0 means extremely toxic
      
      Sentences to analyze:
      ${sentences.map((s, i) => `${i + 1}. "${s}"`).join('\n')}
      
      Format your response as a list of scores and explanations:
      1. Score: [number] - [brief explanation]
      2. Score: [number] - [brief explanation]
      ...
    `;

    const session = createSession().addMessage({
      type: 'system',
      content: prompt,
      metadata: undefined,
    });

    const response = await this.model.send(session);

    // Parse scores for each sentence
    const scoreLines = response.content
      .split('\n')
      .filter((line) => /^\d+\.\s+Score:/.test(line));

    const toxicSentences: {
      sentence: string;
      score: number;
      explanation: string;
    }[] = [];

    for (let i = 0; i < scoreLines.length; i++) {
      const line = scoreLines[i];
      const scoreMatch = line.match(/Score:\s*([\d.]+)/i);

      if (scoreMatch) {
        const score = parseFloat(scoreMatch[1]);

        if (score >= this.threshold) {
          const explanationMatch = line.match(/Score:.*?-(.*)/);
          const explanation = explanationMatch
            ? explanationMatch[1].trim()
            : 'Contains toxic language';

          toxicSentences.push({
            sentence: sentences[i] || '',
            score,
            explanation,
          });
        }
      }
    }

    const passed = toxicSentences.length === 0;

    if (passed) {
      return this.createResult(true);
    } else {
      const feedback = `The following sentences in your response were found to be toxic:\n\n${toxicSentences
        .map((ts) => `- ${ts.sentence}`)
        .join('\n')}`;

      return this.createResult(false, {
        score: Math.max(...toxicSentences.map((ts) => ts.score)),
        feedback,
      });
    }
  }
}

/**
 * Validator that checks for competitor mentions using an LLM
 */
export class CompetitorCheckValidator extends BaseValidator {
  private model: Model;
  private competitors: string[];

  constructor(options: { model: Model; competitors: string[] }) {
    super();
    this.model = options.model;
    this.competitors = options.competitors;
  }

  async validate(content: string): Promise<ValidationResult> {
    const prompt = `
      Analyze the following text and identify if it mentions any of these competitors:
      ${this.competitors.join(', ')}
      
      Text to analyze:
      "${content}"
      
      If any competitors are mentioned, list them. If none are mentioned, say "No competitors mentioned".
      
      Format your response as:
      Competitors: [list of found competitors or "None"]
    `;

    const session = createSession().addMessage({
      type: 'system',
      content: prompt,
      metadata: undefined,
    });

    const response = await this.model.send(session);

    // Check if any competitors were found
    const competitorsMatch = response.content.match(/Competitors:\s*(.*)/i);

    if (
      !competitorsMatch ||
      competitorsMatch[1].toLowerCase().includes('none') ||
      competitorsMatch[1].trim() === ''
    ) {
      return this.createResult(true);
    }

    // Extract the list of found competitors
    const foundCompetitors = competitorsMatch[1]
      .split(',')
      .map((c) => c.trim())
      .filter(
        (c) =>
          c.length > 0 && !['none', 'no competitors'].includes(c.toLowerCase()),
      );

    const passed = foundCompetitors.length === 0;

    return this.createResult(passed, {
      feedback: passed
        ? undefined
        : `Found the following competitors: [${foundCompetitors}]. Please avoid naming those competitors next time`,
    });
  }
}
