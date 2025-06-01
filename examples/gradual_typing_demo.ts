/**
 * Gradual Typing API Demo
 * 
 * This example demonstrates the new gradual typing API for Session creation.
 * It shows how to specify types explicitly when needed while maintaining
 * backward compatibility with existing code.
 */

import { Session } from '../packages/core/src/index';

// Define some types for our demo
type UserContext = {
  userId: string;
  role: 'admin' | 'user' | 'guest';
  preferences: {
    theme: 'light' | 'dark';
    notifications: boolean;
  };
};

type MessageMetadata = {
  role: string;
  hidden: boolean;
  priority: 'low' | 'medium' | 'high';
  timestamp: number;
};

async function main() {
  console.log('🎯 PromptTrail Gradual Typing API Demo\n');

  // 1. Existing API (unchanged - backward compatible)
  console.log('1. Existing API (unchanged):');
  const session1 = Session.create({ vars: { name: 'Alice', age: 30 } });
  console.log(`   User: ${session1.getVar('name')}, Age: ${session1.getVar('age')}\n`);

  // 2. Type-only vars specification
  console.log('2. Type-only vars specification:');
  const session2 = Session.withVarsType<UserContext>().create({
    vars: {
      userId: 'user123',
      role: 'admin',
      preferences: {
        theme: 'dark',
        notifications: true
      }
    }
  });
  console.log(`   User ID: ${session2.getVar('userId')}`);
  console.log(`   Role: ${session2.getVar('role')}`);
  console.log(`   Theme: ${session2.getVar('preferences').theme}\n`);

  // 3. Type-only attrs specification
  console.log('3. Type-only attrs specification:');
  const session3 = Session.withAttrsType<MessageMetadata>().create();
  console.log(`   Messages: ${session3.messages.length}`);
  console.log(`   Vars: ${session3.varsSize}\n`);

  // 4. Both vars and attrs types
  console.log('4. Both vars and attrs types:');
  const session4 = Session.withVarsType<UserContext>()
    .withAttrsType<MessageMetadata>()
    .create({
      vars: {
        userId: 'user456',
        role: 'user',
        preferences: {
          theme: 'light',
          notifications: false
        }
      }
    });
  console.log(`   User ID: ${session4.getVar('userId')}`);
  console.log(`   Role: ${session4.getVar('role')}`);
  console.log(`   Notifications: ${session4.getVar('preferences').notifications}\n`);

  // 5. Chaining with existing session
  console.log('5. Chaining attrs type to existing vars session:');
  const session5 = Session.withVars({
    userId: 'user789',
    role: 'guest' as const,
    preferences: {
      theme: 'dark' as const,
      notifications: true
    }
  }).withAttrsType<MessageMetadata>();
  console.log(`   User ID: ${session5.getVar('userId')}`);
  console.log(`   Role: ${session5.getVar('role')}`);
  console.log(`   Theme: ${session5.getVar('preferences').theme}\n`);

  // 6. Empty session with types
  console.log('6. Empty session with types:');
  const session6 = Session.withVarsType<UserContext>()
    .withAttrsType<MessageMetadata>()
    .empty();
  console.log(`   Messages: ${session6.messages.length}`);
  console.log(`   Vars: ${session6.varsSize}\n`);

  // 7. Debug session with types
  console.log('7. Debug session with types:');
  const session7 = Session.withVarsType<UserContext>()
    .debug({
      vars: {
        userId: 'debug-user',
        role: 'admin',
        preferences: {
          theme: 'dark',
          notifications: true
        }
      }
    });
  console.log(`   Print enabled: ${session7.print}`);
  console.log(`   User ID: ${session7.getVar('userId')}\n`);

  // 8. Mixed chaining (start with attrs)
  console.log('8. Mixed chaining (start with attrs):');
  const session8 = Session.withAttrsType<MessageMetadata>()
    .withVarsType<UserContext>()
    .create({
      vars: {
        userId: 'mixed-user',
        role: 'user',
        preferences: {
          theme: 'light',
          notifications: false
        }
      }
    });
  console.log(`   User ID: ${session8.getVar('userId')}`);
  console.log(`   Role: ${session8.getVar('role')}\n`);

  // 9. Adding attrs type to existing session instance
  console.log('9. Adding attrs type to existing session:');
  const originalSession = Session.create({
    vars: { userId: 'original-user', score: 42 }
  });
  const typedSession = originalSession.withAttrsType<MessageMetadata>();
  console.log(`   Original - User ID: ${originalSession.getVar('userId')}, Score: ${originalSession.getVar('score')}`);
  console.log(`   Typed - User ID: ${typedSession.getVar('userId')}, Score: ${typedSession.getVar('score')}\n`);

  console.log('✅ All examples completed successfully!');
  console.log('\n📝 Key Benefits:');
  console.log('   • Backward compatible - existing code unchanged');
  console.log('   • Explicit typing - withVarsType vs withAttrsType (no confusion)');
  console.log('   • Flexible - support both value inference and type-only');
  console.log('   • Chainable - compose types step by step');
  console.log('   • Gradual adoption - use when you need better typing');
}

// Run the demo
main().catch(console.error);