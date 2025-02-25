#!/bin/bash

# 🧪 PromptTrail Template Visualizer Test Script 🧪
# This script checks that all necessary components exist

# Don't exit on error, just track failures
failures=0

echo "🧪 Testing PromptTrail Template Visualizer..."
echo "============================================="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
  echo "⚠️  Please run this script from the visualizer directory"
  echo "   cd dogfooding/visualizer"
  exit 1
fi

# Check if dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "⚠️ Dependencies not installed. Please run ./run.sh first."
  exit 1
fi

echo "🔍 Checking visualizer files..."

# Test the template store
echo "📊 Testing template store..."
if [ -f "src/utils/templateStore.ts" ]; then
  echo "✅ Template store exists"
else
  echo "❌ Template store missing"
  ((failures++))
fi

# Test the template type definitions
echo "📋 Testing template type definitions..."
if [ -f "src/utils/templateTypes.ts" ]; then
  echo "✅ Template type definitions exist"
else
  echo "❌ Template type definitions missing"
  ((failures++))
fi

# Test the template components
echo "🧩 Testing template components..."
missing_components=()
for component in "TemplateNode" "TemplateContainer" "TemplatePropertyPanel" "TemplateCodePanel" "TemplateToolbar"; do
  if [ ! -f "src/components/${component}.tsx" ]; then
    missing_components+=("$component")
  fi
done

if [ ${#missing_components[@]} -eq 0 ]; then
  echo "✅ All core template components exist"
else
  echo "❌ Missing components: ${missing_components[*]}"
  ((failures++))
fi

# Test the template content components
echo "📝 Testing template content components..."
if [ ! -d "src/components/templates" ]; then
  echo "❌ Templates directory missing"
  ((failures++))
else
  missing_templates=()
  for template in "SystemTemplateContent" "UserTemplateContent" "AssistantTemplateContent" "LoopTemplateContent" "SubroutineTemplateContent"; do
    if [ ! -f "src/components/templates/${template}.tsx" ]; then
      missing_templates+=("$template")
    fi
  done

  if [ ${#missing_templates[@]} -eq 0 ]; then
    echo "✅ All template content components exist"
  else
    echo "❌ Missing template components: ${missing_templates[*]}"
    ((failures++))
  fi
fi

# Test the example templates
echo "📚 Testing example templates..."
if [ -f "src/examples/simple_template.ts" ]; then
  echo "✅ Example template exists"
else
  echo "❌ Example template missing"
  ((failures++))
fi

echo "============================================="
if [ $failures -eq 0 ]; then
  echo "🎉 All tests passed! The Template Visualizer is ready to use."
  echo "▶️  Run ./run.sh to start the development server."
  exit 0
else
  echo "⚠️  Found $failures issues that need to be fixed."
  exit 1
fi