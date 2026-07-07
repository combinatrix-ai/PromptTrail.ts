/**
 * Gradual Typing API Demo
 *
 * This example demonstrates the gradual typing API for Session creation.
 * It shows how to specify types explicitly when inference is not enough.
 */

import { Session } from '@prompttrail/core';

// Define some types for our demo
type UserContext = {
  userId: string;
  role: 'admin' | 'user' | 'guest';
  preferences: {
    theme: 'light' | 'dark';
    notifications: boolean;
  };
};

async function main() {
  console.log('🎯 PromptTrail Gradual Typing API Demo\n');

  // 1. Inferred vars from create()
  console.log('1. Inferred vars from create():');
  const session1 = Session.create({ vars: { name: 'Alice', age: 30 } });
  console.log(
    `   User: ${session1.getVar('name')}, Age: ${session1.getVar('age')}\n`,
  );

  // 2. Type-only vars specification
  console.log('2. Type-only vars specification:');
  const session2 = Session.withVarsType<UserContext>().create({
    vars: {
      userId: 'user123',
      role: 'admin',
      preferences: {
        theme: 'dark',
        notifications: true,
      },
    },
  });
  console.log(`   User ID: ${session2.getVar('userId')}`);
  console.log(`   Role: ${session2.getVar('role')}`);
  console.log(`   Theme: ${session2.getVar('preferences').theme}\n`);

  // 3. Empty session with a vars type
  console.log('3. Empty session with a vars type:');
  const session3 = Session.withVarsType<UserContext>().empty();
  console.log(`   Messages: ${session3.messages.length}`);
  console.log(`   Vars: ${session3.varsSize}\n`);

  // 4. Debug session with a vars type
  console.log('4. Debug session with a vars type:');
  const session4 = Session.withVarsType<UserContext>().debug({
    vars: {
      userId: 'debug-user',
      role: 'admin',
      preferences: {
        theme: 'dark',
        notifications: true,
      },
    },
  });
  console.log(`   Print enabled: ${session4.print}`);
  console.log(`   User ID: ${session4.getVar('userId')}`);
  console.log(`   Theme: ${session4.getVar('preferences').theme}\n`);

  // 5. Inferred vars from an existing vars session
  console.log('5. Inferred vars from an existing vars session:');
  const session5 = Session.withVars({
    userId: 'user789',
    role: 'guest' as const,
    preferences: {
      theme: 'dark' as const,
      notifications: true,
    },
  });
  console.log(`   User ID: ${session5.getVar('userId')}`);
  console.log(`   Role: ${session5.getVar('role')}`);
  console.log(`   Theme: ${session5.getVar('preferences').theme}\n`);

  // 6. Builder chaining can refine the vars type before creation
  console.log('6. Builder chaining for vars types:');
  const session6 = Session.withVarsType<{ traceId: string }>()
    .withVarsType<UserContext>()
    .create({
      vars: {
        userId: 'builder-user',
        role: 'user',
        preferences: {
          theme: 'light',
          notifications: false,
        },
      },
    });
  console.log(`   User ID: ${session6.getVar('userId')}`);
  console.log(`   Role: ${session6.getVar('role')}\n`);

  // 7. Immutable vars growth on an existing session
  console.log('7. Immutable vars growth on an existing session:');
  const originalSession = Session.create({
    vars: { userId: 'original-user' },
  });
  const scoredSession = originalSession.withVar('score', 42);
  console.log(`   Original - User ID: ${originalSession.getVar('userId')}`);
  console.log(
    `   Scored - User ID: ${scoredSession.getVar('userId')}, Score: ${scoredSession.getVar('score')}\n`,
  );

  console.log('✅ All examples completed successfully!');
  console.log('\n📝 Key Benefits:');
  console.log('   • Inference first - values define vars when possible');
  console.log('   • Explicit typing - withVarsType when no values exist yet');
  console.log('   • Flexible - support both value inference and type-only');
  console.log('   • Chainable - refine vars before creating a session');
  console.log('   • Gradual adoption - use when you need better typing');
}

// Run the demo
main().catch(console.error);
