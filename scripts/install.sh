#!/bin/sh

# Find a compatible Node.js runtime before invoking the JavaScript installer.
# This script intentionally uses only POSIX shell built-ins plus the selected
# Node.js executable, so a fresh macOS installation does not need Homebrew,
# npm, dirname, sed, or any other helper command.

set -u

minimum_node_major=22

print_error() {
  printf '%s\n' "$*" >&2
}

is_supported_node() {
  node_candidate=$1

  if [ ! -x "$node_candidate" ]; then
    return 1
  fi

  node_version=$("$node_candidate" --version 2>/dev/null) || return 1
  case $node_version in
    v*) node_version=${node_version#v} ;;
  esac
  node_major=${node_version%%.*}

  case $node_major in
    ''|*[!0-9]*) return 1 ;;
  esac

  [ "$node_major" -ge "$minimum_node_major" ] 2>/dev/null
}

resolve_explicit_node() {
  explicit_node=$1
  case $explicit_node in
    */*) printf '%s\n' "$explicit_node" ;;
    *) command -v "$explicit_node" 2>/dev/null ;;
  esac
}

select_node() {
  if [ "${CODEX_BARK_NODE+x}" = x ]; then
    if [ -z "$CODEX_BARK_NODE" ]; then
      print_error "CODEX_BARK_NODE is set but empty. Set it to a Node.js ${minimum_node_major}+ executable."
      return 1
    fi

    selected_override=$(resolve_explicit_node "$CODEX_BARK_NODE") || {
      print_error "CODEX_BARK_NODE does not resolve to an executable: $CODEX_BARK_NODE"
      return 1
    }
    if ! is_supported_node "$selected_override"; then
      print_error "CODEX_BARK_NODE must be a working Node.js ${minimum_node_major}+ executable: $CODEX_BARK_NODE"
      return 1
    fi
    printf '%s\n' "$selected_override"
    return 0
  fi

  # The override below is intentionally private to the test suite. Production
  # callers use the literal /Applications root.
  system_applications=${_CODEX_BARK_TEST_APPLICATIONS_ROOT:-/Applications}

  for bundled_node in \
    "$system_applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "$system_applications/Codex.app/Contents/Resources/cua_node/bin/node"
  do
    if is_supported_node "$bundled_node"; then
      printf '%s\n' "$bundled_node"
      return 0
    fi
  done

  if [ -n "${HOME:-}" ]; then
    for bundled_node in \
      "$HOME/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
      "$HOME/Applications/Codex.app/Contents/Resources/cua_node/bin/node"
    do
      if is_supported_node "$bundled_node"; then
        printf '%s\n' "$bundled_node"
        return 0
      fi
    done
  fi

  # Keep PATH as the final fallback. Homebrew's public bin/node symlink is more
  # stable than the versioned Cellar path reported by process.execPath, so the
  # wrapper passes this selected path through to the installer below.
  path_node=$(command -v node 2>/dev/null) || path_node=
  if [ -n "$path_node" ] && is_supported_node "$path_node"; then
    printf '%s\n' "$path_node"
    return 0
  fi

  print_error "No compatible Node.js runtime found. Node.js ${minimum_node_major}+ is required."
  print_error "Install/update the Codex desktop app, install Node.js ${minimum_node_major}+, or set CODEX_BARK_NODE."
  return 1
}

script_path=$0
case $script_path in
  */*) ;;
  *)
    script_path=$(command -v "$script_path" 2>/dev/null) || {
      print_error "Unable to locate installer bootstrap: $0"
      exit 1
    }
    ;;
esac
case $script_path in
  /*) ;;
  *) script_path=$PWD/$script_path ;;
esac

script_directory=${script_path%/*}
project_directory=${script_directory%/*}
node_executable=$(select_node) || exit 1
case $node_executable in
  /*) ;;
  *) node_executable=$PWD/$node_executable ;;
esac
_CODEX_BARK_SELECTED_NODE=$node_executable
export _CODEX_BARK_SELECTED_NODE

case ${1-} in
  --verify)
    if [ "$#" -ne 1 ]; then
      print_error "--verify does not accept additional arguments."
      exit 2
    fi
    "$node_executable" --check "$project_directory/src/bark-notify.mjs" || exit $?
    "$node_executable" --check "$project_directory/scripts/install.mjs" || exit $?
    "$node_executable" --check "$project_directory/scripts/uninstall.mjs" || exit $?
    cd "$project_directory" || {
      print_error "Unable to enter project directory: $project_directory"
      exit 1
    }
    exec "$node_executable" --test
    ;;
  --send-test)
    if [ "$#" -ne 1 ]; then
      print_error "--send-test does not accept additional arguments."
      exit 2
    fi
    if [ -n "${CODEX_HOME:-}" ]; then
      codex_home=$CODEX_HOME
    elif [ -n "${HOME:-}" ]; then
      codex_home=$HOME/.codex
    else
      print_error "--send-test requires CODEX_HOME or HOME to locate the installed notifier."
      exit 1
    fi
    notifier_entry=$codex_home/notifications/codex-bark/bark-notify.mjs
    if [ ! -f "$notifier_entry" ]; then
      print_error "Installed Codex Bark notifier not found: $notifier_entry"
      exit 1
    fi
    exec "$node_executable" "$notifier_entry" --test
    ;;
  --uninstall)
    shift
    uninstaller_entry=$script_directory/uninstall.mjs
    if [ ! -f "$uninstaller_entry" ]; then
      print_error "Uninstaller entry point not found: $uninstaller_entry"
      exit 1
    fi
    exec "$node_executable" "$uninstaller_entry" "$@"
    ;;
esac

installer_entry=$script_directory/install.mjs
if [ ! -f "$installer_entry" ]; then
  print_error "Installer entry point not found: $installer_entry"
  exit 1
fi

exec "$node_executable" "$installer_entry" "$@"
