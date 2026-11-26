#!/bin/sh
# omp-bad-fseventsd root helper: lists fseventsd's clients and restarts it.
#
# Installed by `/fsnuke install` to /Library/PrivilegedHelperTools/omp-bad-fseventsd
# (root:wheel 755) with one sudoers rule for the installing user and these two
# exact commands, no other arguments:
#   <user> ALL=(root) NOPASSWD: <helper> clients, <helper> restart
#
# Every limit lives here, in a root-owned file, so nothing running as the user
# (an agent included) can loosen it:
#   - acts only on Apple's fseventsd binary, matched by exact path
#   - restarts only above MIN_MB, at most once per MIN_INTERVAL_SEC
#   - fixed PATH, no input besides the one-word command
#   - every call, refusals included, goes to $LOG and the system log
#
# Output: key=value lines on stdout.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 022

DAEMON=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/FSEvents.framework/Versions/A/Support/fseventsd
HISTORY=/System/Volumes/Data/.fseventsd
STATE=/var/db/omp-bad-fseventsd
LOG=/var/log/omp-bad-fseventsd.log
MIN_MB=1024
MIN_INTERVAL_SEC=1800
SNAPSHOT_FILES=2000

log() {
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) user=${SUDO_USER:-root} $*" >>"$LOG"
	logger "omp-bad-fseventsd: user=${SUDO_USER:-root} $*" # the unified log drops -t tags
}

stop() {
	log "stopped $1"
	echo "error=$1"
	exit 1
}

# daemon_pid: the single running fseventsd, only if it is Apple's binary.
daemon_pid() {
	p=$(pgrep -x fseventsd) || return 1
	case $p in '' | *[!0-9]*) return 1 ;; esac
	[ "$(ps -o comm= -p "$p")" = "$DAEMON" ] || return 1
	echo "$p"
}

# mem_mb <pid>: footprint in MB, from top's MEM column (counts compressed pages; ps rss does not).
mem_mb() {
	top -l 1 -pid "$1" -stats pid,mem | awk -v p="$1" '$1 == p {
		s = $2; sub(/[+-]$/, "", s); u = substr(s, length(s)); n = substr(s, 1, length(s) - 1) + 0
		if (u == "G") n *= 1024; else if (u == "T") n *= 1048576; else if (u == "K") n /= 1024; else if (u == "B") n /= 1048576
		printf "%d\n", n
	}'
}

# clients <pid>: pids holding an event stream; fseventsd names one thread per client.
clients() {
	sample "$1" 1 -file /dev/stdout 2>/dev/null |
		grep -o 'com\.apple\.fseventsd\.client\.[0-9]*' | sed 's/.*\.//' | sort -un | tr '\n' ' '
}

# snapshot: copy the newest event-history files for the caller to read; the restart may erase them.
# $STATE is root-owned, so the caller cannot plant a symlink in place of the snapshot directory.
snapshot() {
	dir=$STATE/snapshot
	rm -rf "$dir"
	mkdir -m 700 "$dir" || return 0
	(cd "$HISTORY" && ls | grep -E '^[0-9a-f]{16}$' | sort | tail -n "$SNAPSHOT_FILES" | tar -cf - -T -) |
		tar -xf - -C "$dir"
	case ${SUDO_UID:-} in '' | *[!0-9]*) ;; *) chown -R "$SUDO_UID" "$dir" ;; esac
}

cmd_clients() {
	pid=$(daemon_pid) || stop no-daemon
	c=$(clients "$pid")
	log "clients pid=$pid [$c]"
	printf 'pid=%s\nmem_mb=%s\nclients=%s\n' "$pid" "$(mem_mb "$pid")" "$c"
}

cmd_restart() {
	pid=$(daemon_pid) || stop no-daemon
	mb=$(mem_mb "$pid")
	[ "${mb:-0}" -ge "$MIN_MB" ] || stop "below-floor mem_mb=${mb:-?}"
	mkdir -p -m 755 "$STATE"
	now=$(date +%s)
	last=$(cat "$STATE/last-restart" 2>/dev/null) || last=0
	case $last in '' | *[!0-9]*) last=0 ;; esac
	[ $((now - last)) -ge "$MIN_INTERVAL_SEC" ] || stop "rate-limited retry_in_sec=$((MIN_INTERVAL_SEC - now + last))"
	echo "$now" >"$STATE/last-restart" # before the kill: a failed attempt counts too

	before=$(clients "$pid")
	snapshot
	kill -TERM "$pid"
	i=0
	while [ $i -lt 10 ] && kill -0 "$pid" 2>/dev/null; do
		sleep 1
		i=$((i + 1))
	done
	# A runaway daemon can ignore SIGTERM. Re-check the binary: the pid may have been reused.
	[ "$(ps -o comm= -p "$pid")" = "$DAEMON" ] && kill -KILL "$pid"

	new=''
	i=0
	while [ $i -lt 30 ]; do
		new=$(daemon_pid) && [ "$new" != "$pid" ] && break
		new=''
		sleep 1
		i=$((i + 1))
	done
	[ -n "$new" ] || stop "no-respawn old_pid=$pid"
	sleep 5 # clients that reconnect do so within seconds
	after=$(clients "$new")
	new_mb=$(mem_mb "$new")
	log "restarted old_pid=$pid mem_mb=$mb new_pid=$new new_mem_mb=$new_mb clients_before=[$before] clients_after=[$after]"
	printf 'mem_mb=%s\nnew_mem_mb=%s\nclients_before=%s\nclients_after=%s\n' "$mb" "$new_mb" "$before" "$after"
}

[ "$(id -u)" = 0 ] || {
	echo "error=not-root"
	exit 77
}
case "$#:${1:-}" in
1:clients) cmd_clients ;;
1:restart) cmd_restart ;;
*) stop bad-args ;;
esac
