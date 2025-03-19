#!/bin/bash

# This script removes duplicate test files after the test reorganization

echo "Removing duplicate test files..."

# Remove unit test duplicates
rm -f packages/core/src/__tests__/session.test.ts
rm -f packages/core/src/__tests__/metadata.test.ts
rm -f packages/core/src/__tests__/input_source.test.ts
rm -f packages/core/src/__tests__/templates.test.ts
rm -f packages/core/src/__tests__/markdown_extractor.test.ts
rm -f packages/core/src/__tests__/pattern_extractor.test.ts
rm -f packages/core/src/__tests__/schema_validation.test.ts
rm -f packages/core/src/__tests__/openai.test.ts
rm -f packages/core/src/__tests__/anthropic.test.ts
rm -f packages/core/src/__tests__/anthropic_schema.test.ts

# Remove integration test duplicates
rm -f packages/core/src/__tests__/mcp_integration.test.ts
rm -f packages/core/src/__tests__/real_mcp_integration.test.ts
rm -f packages/core/src/__tests__/schema_template.test.ts
rm -f packages/core/src/__tests__/guardrail_template.test.ts

echo "Duplicate test files removed."
echo "Run tests to verify everything still works: ./packages/core/src/__tests__/run_tests.sh"
