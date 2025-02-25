#!/bin/bash

# Exit on error
set -e

echo "🚀 PromptTrail Template Visualizer Setup 🚀"
echo "==========================================="

# Create a standalone setup to avoid core package build issues
echo "📦 Setting up visualizer dependencies..."

# Check if we're already in the visualizer directory
if [ ! -f "package.json" ]; then
  echo "⚠️  Please run this script from the visualizer directory"
  echo "   cd dogfooding/visualizer"
  exit 1
fi

# Install dependencies
echo "📥 Installing dependencies..."
pnpm install --no-workspace || {
  echo "⚠️  Failed to install dependencies with pnpm, trying npm..."
  npm install
}

# Install specific packages that might be missing
echo "🧩 Installing additional packages..."
pnpm add -D tailwindcss autoprefixer postcss || npm install -D tailwindcss autoprefixer postcss
pnpm add reactflow@11.10.1 zustand@4.4.7 nanoid@5.0.4 @monaco-editor/react@4.6.0 || npm install reactflow@11.10.1 zustand@4.4.7 nanoid@5.0.4 @monaco-editor/react@4.6.0

# Fix package name issue for reactflow
echo "🔧 Fixing package compatibility issues..."
if [ ! -d "node_modules/@reactflow" ]; then
  mkdir -p node_modules/@reactflow
fi

if [ ! -d "node_modules/@reactflow/core" ]; then
  ln -s ../reactflow node_modules/@reactflow/core
fi

# Update imports to use reactflow instead of @reactflow/core
echo "🔄 Updating import statements..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  # macOS version
  find src -type f -name "*.tsx" -exec sed -i '' 's/@reactflow\/core/reactflow/g' {} \;
else
  # Linux version
  find src -type f -name "*.tsx" -exec sed -i 's/@reactflow\/core/reactflow/g' {} \;
fi

echo "✅ Setup complete!"
echo "🌐 Starting development server..."
echo "-------------------------------------------"
echo "If the server fails to start, try running:"
echo "cd dogfooding/visualizer"
echo "pnpm dev  # or: npm run dev"
echo "-------------------------------------------"

# Start development server
pnpm dev || npm run dev