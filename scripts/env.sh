#!/bin/bash
# Use your installed JDK 17 and Android SDK; do not commit local.properties.
if [ -z "${JAVA_HOME:-}" ] && [ -x /usr/libexec/java_home ]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 17)"; export JAVA_HOME
fi
: "${JAVA_HOME:?Set JAVA_HOME to your JDK 17 directory}"
if [ -z "${ANDROID_HOME:-}" ]; then
  if [ -n "${ANDROID_SDK_ROOT:-}" ]; then ANDROID_HOME="$ANDROID_SDK_ROOT";
  elif [ -d "$HOME/Library/Android/sdk" ]; then ANDROID_HOME="$HOME/Library/Android/sdk";
  else echo 'Set ANDROID_HOME to your Android SDK directory.' >&2; return 1; fi
fi
export ANDROID_HOME
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
