#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
root=${KNOWLEDGE_BITS_ROOT:-${script_dir:h:h}}
env_file=${KNOWLEDGE_BITS_ENV_FILE:-${root}/.env}
launch_agents_dir="$HOME/Library/LaunchAgents"
api_label="app.knowledge-bits.api"
worker_label="app.knowledge-bits.worker-tick"
api_plist="${launch_agents_dir}/${api_label}.plist"
worker_plist="${launch_agents_dir}/${worker_label}.plist"
log_dir="${root}/.local-supervisor"
uid=$(id -u)

if [[ ! -f "$env_file" ]]; then
  print -u2 "Knowledge Bits environment file not found: $env_file"
  exit 1
fi

case "$root" in
  "$HOME/Documents"/*|"$HOME/Desktop"/*|"$HOME/Downloads"/*)
    print -u2 "launchd cannot reliably read a Knowledge Bits checkout under a protected macOS folder."
    print -u2 "Use a runtime checkout outside Documents, Desktop, and Downloads, for example ~/Developer/knowledge-bits."
    exit 1
    ;;
esac

mkdir -p "$launch_agents_dir" "$log_dir"

write_plist() {
  local label=$1
  local program=$2
  local output=$3
  local error=$4
  local interval=${5:-}

  {
    print '<?xml version="1.0" encoding="UTF-8"?>'
    print '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    print '<plist version="1.0"><dict>'
    print "<key>Label</key><string>${label}</string>"
    print '<key>ProgramArguments</key><array>'
    # Running the interpreter explicitly avoids launchd rejecting scripts in a
    # Git worktree even though the same scripts are executable interactively.
    print '<string>/bin/zsh</string>'
    print "<string>${program}</string>"
    print '</array>'
    print '<key>EnvironmentVariables</key><dict>'
    print "<key>KNOWLEDGE_BITS_ROOT</key><string>${root}</string>"
    print "<key>KNOWLEDGE_BITS_ENV_FILE</key><string>${env_file}</string>"
    print '</dict>'
    print '<key>RunAtLoad</key><true/>'
    if [[ -n "$interval" ]]; then
      print "<key>StartInterval</key><integer>${interval}</integer>"
    else
      print '<key>KeepAlive</key><true/>'
    fi
    print "<key>StandardOutPath</key><string>${output}</string>"
    print "<key>StandardErrorPath</key><string>${error}</string>"
    print '</dict></plist>'
  }
}

write_plist "$api_label" "${script_dir}/knowledge-bits-api.zsh" \
  "${log_dir}/api.log" "${log_dir}/api.error.log" > "$api_plist"
write_plist "$worker_label" "${script_dir}/knowledge-bits-worker-tick.zsh" \
  "${log_dir}/worker.log" "${log_dir}/worker.error.log" "300" > "$worker_plist"

plutil -lint "$api_plist" >/dev/null
plutil -lint "$worker_plist" >/dev/null
chmod 600 "$api_plist" "$worker_plist"

launchctl bootout "gui/${uid}/${api_label}" 2>/dev/null || true
launchctl bootout "gui/${uid}/${worker_label}" 2>/dev/null || true
launchctl bootstrap "gui/${uid}" "$api_plist"
launchctl bootstrap "gui/${uid}" "$worker_plist"
launchctl kickstart -k "gui/${uid}/${api_label}"
launchctl kickstart -k "gui/${uid}/${worker_label}"

print "Knowledge Bits local supervisor installed."
print "API log: ${log_dir}/api.log"
print "Worker log: ${log_dir}/worker.log"
print "The worker starts at login and then every 5 minutes."
