import Handlebars from 'handlebars';
import type { Session } from '../session';
import type { Attrs, Vars } from '../session';

// Create a dedicated Handlebars instance for PromptTrail
const handlebars = Handlebars.create();

// Register custom helpers for PromptTrail.ts
registerPromptTrailHelpers();

/**
 * Register custom Handlebars helpers specifically designed for PromptTrail.ts
 */
function registerPromptTrailHelpers() {
  // Helper: Join array elements with a separator
  handlebars.registerHelper(
    'join',
    function (array: unknown[], separator: string = ', ') {
      if (!Array.isArray(array)) {
        return '';
      }
      return array.map((item) => String(item)).join(separator);
    },
  );

  // Helper: Format numbers with locale-specific formatting
  handlebars.registerHelper(
    'formatNumber',
    function (value: number, locale: string = 'en-US') {
      if (typeof value !== 'number') {
        return String(value);
      }
      return new Intl.NumberFormat(locale).format(value);
    },
  );

  // Helper: Truncate text to a specified length
  handlebars.registerHelper(
    'truncate',
    function (text: string, length?: number, suffix?: string) {
      // Handlebars passes options as the last argument
      const args = Array.from(arguments);
      const options = args[args.length - 1];

      const actualLength = typeof length === 'number' ? length : 100;
      const actualSuffix = typeof suffix === 'string' ? suffix : '...';

      if (typeof text !== 'string') {
        return String(text);
      }
      if (text.length <= actualLength) {
        return text;
      }
      return text.substring(0, actualLength) + actualSuffix;
    },
  );

  // Helper: Debug helper for development (prints value to console and returns it)
  handlebars.registerHelper('debug', function (value: unknown, label?: string) {
    if (label) {
      console.log(`[DEBUG ${label}]:`, value);
    } else {
      console.log('[DEBUG]:', value);
    }
    return value;
  });

  // Helper: Convert array to numbered list
  handlebars.registerHelper(
    'numberedList',
    function (array: unknown[], startIndex?: number) {
      const actualStartIndex = typeof startIndex === 'number' ? startIndex : 1;

      if (!Array.isArray(array)) {
        return '';
      }
      return array
        .map((item, index) => `${index + actualStartIndex}. ${String(item)}`)
        .join('\n');
    },
  );

  // Helper: Convert array to bullet list
  handlebars.registerHelper(
    'bulletList',
    function (array: unknown[], bullet?: string) {
      const actualBullet = typeof bullet === 'string' ? bullet : '-';

      if (!Array.isArray(array)) {
        return '';
      }
      return array.map((item) => `${actualBullet} ${String(item)}`).join('\n');
    },
  );

  // Helper: Check if value is empty (null, undefined, empty string, empty array)
  handlebars.registerHelper('isEmpty', function (value: unknown) {
    if (value === null || value === undefined) {
      return true;
    }
    if (typeof value === 'string') {
      return value.trim().length === 0;
    }
    if (Array.isArray(value)) {
      return value.length === 0;
    }
    if (typeof value === 'object') {
      return Object.keys(value).length === 0;
    }
    return false;
  });

  // Helper: Check if value is not empty
  handlebars.registerHelper('isNotEmpty', function (value: unknown) {
    return !handlebars.helpers!['isEmpty'](value);
  });

  // Helper: Get array length
  handlebars.registerHelper('length', function (array: unknown) {
    if (Array.isArray(array)) {
      return array.length;
    }
    if (typeof array === 'string') {
      return array.length;
    }
    if (array && typeof array === 'object') {
      return Object.keys(array).length;
    }
    return 0;
  });

  // Helper: Format date/timestamp
  handlebars.registerHelper(
    'formatDate',
    function (date: Date | string | number, format: string = 'en-US') {
      try {
        const dateObj = new Date(date);
        return dateObj.toLocaleDateString(format);
      } catch {
        return String(date);
      }
    },
  );

  // Helper: Conditional equality check
  handlebars.registerHelper('eq', function (a: unknown, b: unknown) {
    return a === b;
  });

  // Helper: Conditional greater than
  handlebars.registerHelper('gt', function (a: number, b: number) {
    return a > b;
  });

  // Helper: Conditional less than
  handlebars.registerHelper('lt', function (a: number, b: number) {
    return a < b;
  });
}

/**
 * Interpolates template strings using Handlebars
 * @param template The template string with Handlebars syntax
 * @param session The session containing context values for interpolation
 * @returns The interpolated string
 */
export function interpolateTemplate<TVars extends Vars, TAttrs extends Attrs>(
  template: string,
  session: Session<TVars, TAttrs> | Vars | Record<string, unknown>,
): string {
  // Extract the context data from the session
  let context: Record<string, unknown>;

  if ('vars' in session && session.vars) {
    // If it's a Session object, use its vars
    context = session.vars as Record<string, unknown>;
  } else {
    // If it's a Vars object or plain object, use it directly
    context = session as Record<string, unknown>;
  }

  try {
    // Compile and render the template with Handlebars
    const compiledTemplate = handlebars.compile(template);
    return compiledTemplate(context);
  } catch (error) {
    // Log the error for debugging but return the original template
    console.error('Template interpolation error:', error);
    console.error('Template:', template);
    console.error('Context:', context);

    // Return original template with error message for debugging
    return `[TEMPLATE ERROR: ${error instanceof Error ? error.message : 'Unknown error'}]\n${template}`;
  }
}

/**
 * Get the Handlebars instance for advanced usage (e.g., registering custom helpers)
 * @returns The Handlebars instance used by PromptTrail.ts
 */
export function getHandlebarsInstance(): typeof handlebars {
  return handlebars;
}

/**
 * Register a custom helper with the PromptTrail Handlebars instance
 * @param name The name of the helper
 * @param helperFunction The helper function
 */
export function registerHelper(
  name: string,
  helperFunction: Handlebars.HelperDelegate,
) {
  handlebars.registerHelper(name, helperFunction);
}

/**
 * Register multiple custom helpers at once
 * @param helpers An object with helper names as keys and helper functions as values
 */
export function registerHelpers(
  helpers: Record<string, Handlebars.HelperDelegate>,
) {
  Object.entries(helpers).forEach(([name, helperFunction]) => {
    handlebars.registerHelper(name, helperFunction);
  });
}
