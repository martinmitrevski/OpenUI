#!/bin/sh
# Regenerates openui/system-prompt.md from the Swift chat component library, tools.json and
# prompt-options.json. It runs the SampleBackendTests prompt test in export mode on macOS.
set -e
cd "$(dirname "$0")/../.."
TEST_RUNNER_OPENUI_EXPORT=1 xcodebuild test \
  -project OpenUI.xcodeproj \
  -scheme OpenUI \
  -destination 'platform=macOS' \
  -only-testing:'OpenUITests/SampleBackendTests/systemPromptIsUpToDate()' \
  -quiet
echo "Updated SampleBackend/openui/system-prompt.md"
