// The OS boundary: top, ps, the root helper, macOS's admin prompt, the history snapshot.
// Takes omp's `pi.exec` so tests can pass a plain spawn shim.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type Client, churnDir, historyPaths, parseClients, parseKv, parseTopMem } from "./scan.ts";

export type Exec = ExtensionAPI["exec"];

export const HELPER = "/Library/PrivilegedHelperTools/omp-bad-fseventsd";
export const SUDOERS = "/etc/sudoers.d/omp-bad-fseventsd";
export const AUDIT_LOG = "/var/log/omp-bad-fseventsd.log";
const STATE_DIR = "/var/db/omp-bad-fseventsd";
const SNAPSHOT = `${STATE_DIR}/snapshot`;
export const bundledHelper = path.join(import.meta.dir, "..", "helper", "omp-bad-fseventsd.sh");
const EOF = "OMP_BAD_FSEVENTSD_HELPER";

/** fseventsd's footprint in MB, without root: top reads it for any process. */
export async function daemonMB(exec: Exec): Promise<number | undefined> {
	const pid = Number((await exec("/usr/bin/pgrep", ["-x", "fseventsd"])).stdout.trim());
	if (!pid) return undefined;
	const top = await exec("/usr/bin/top", ["-l", "1", "-pid", String(pid), "-stats", "pid,mem"], { timeout: 15_000 });
	return parseTopMem(top.stdout, pid);
}

/** Installed means root-owned, with its sudoers rule, and the same code this version ships. */
export function helperState(): "missing" | "outdated" | "installed" {
	try {
		if (fs.statSync(HELPER).uid !== 0 || !fs.existsSync(SUDOERS)) return "missing";
		return fs.readFileSync(HELPER, "utf8") === fs.readFileSync(bundledHelper, "utf8") ? "installed" : "outdated";
	} catch {
		return "missing";
	}
}

export async function runHelper(exec: Exec, command: "clients" | "restart"): Promise<Record<string, string>> {
	const res = await exec("/usr/bin/sudo", ["-n", HELPER, command], { timeout: 120_000 });
	const kv = parseKv(res.stdout);
	if (res.code !== 0) kv.error ||= res.stderr.trim() || `exit ${res.code}`;
	return kv;
}

/** Live processes among `pids`, with the omp session that started each, if any. */
export async function describe(exec: Exec, pids: number[]): Promise<Client[]> {
	if (pids.length === 0) return [];
	const list = pids.join(",");
	const [names, withEnv] = await Promise.all([
		exec("/bin/ps", ["-o", "pid=,comm=", "-p", list]),
		exec("/bin/ps", ["-wwE", "-o", "pid=,command=", "-p", list]),
	]);
	return parseClients(names.stdout, withEnv.stdout);
}

/** Runs a root shell script behind macOS's own password dialog. The script travels as an argument, never a file. */
export function asAdmin(exec: Exec, script: string, prompt: string) {
	const applescript = "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges";
	return exec("/usr/bin/osascript", ["-e", "on run argv", "-e", applescript, "-e", "end run", script, prompt], {
		timeout: 300_000,
	});
}

export function installScript(user: string, helper: string): string {
	if (!/^[a-z_][a-z0-9_-]*$/.test(user)) throw new Error(`unsupported user name for sudoers: ${user}`);
	if (helper.includes(EOF)) throw new Error("helper text contains the heredoc delimiter");
	return [
		"set -eu",
		"umask 022",
		"mkdir -p /Library/PrivilegedHelperTools /etc/sudoers.d",
		// The helper is written from this argument, not copied from a user-writable file.
		`tmp=$(mktemp ${HELPER}.XXXXXX)`,
		`cat >"$tmp" <<'${EOF}'`,
		helper.trimEnd(),
		EOF,
		`chown root:wheel "$tmp" && chmod 755 "$tmp" && mv -f "$tmp" ${HELPER}`,
		// sudo skips sudoers.d names containing a dot, so the rule is inert until validated and renamed.
		"rule=$(mktemp /etc/sudoers.d/.omp-bad-fseventsd.XXXXXX)",
		`echo '${user} ALL=(root) NOPASSWD: ${HELPER} clients, ${HELPER} restart' >"$rule"`,
		'chown root:wheel "$rule" && chmod 440 "$rule"',
		'visudo -cf "$rule" >/dev/null || { rm -f "$rule"; exit 1; }',
		`mv -f "$rule" ${SUDOERS}`,
		`touch ${AUDIT_LOG} && chmod 644 ${AUDIT_LOG}`,
		`echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) user=${user} installed" >>${AUDIT_LOG}`,
	].join("\n");
}

export const uninstallScript = (user: string): string =>
	[
		`rm -f ${HELPER} ${SUDOERS}`,
		`rm -rf ${STATE_DIR}`,
		`echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) user=${user.replace(/[^\w-]/g, "")} uninstalled" >>${AUDIT_LOG}`,
	].join("\n");

/** Event counts per directory from the helper's history snapshot; deletes the snapshot as it goes. */
export async function readSnapshot(home: string): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	let files: string[] = [];
	try {
		files = fs.readdirSync(SNAPSHOT);
	} catch {
		return counts;
	}
	for (const name of files) {
		const file = path.join(SNAPSHOT, name);
		try {
			for (const p of historyPaths(Bun.gunzipSync(fs.readFileSync(file)))) {
				const dir = churnDir(p, home);
				counts.set(dir, (counts.get(dir) ?? 0) + 1);
			}
			fs.rmSync(file);
		} catch {}
		await Bun.sleep(0); // thousands of files: let omp's UI breathe between them
	}
	return counts;
}

export function auditTail(lines: number): string[] {
	try {
		return fs.readFileSync(AUDIT_LOG, "utf8").trim().split("\n").slice(-lines);
	} catch {
		return [];
	}
}
