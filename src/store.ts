// Local state under <agent dir>/bad-fseventsd/, shared by every omp process on this machine.
//
//   state.json   { memMB, at, restart: { at, lost } }   last reading, last restart
//   leader.json  { pid, ts }                             which omp process measures
//
// Tunables are omp plugin settings (`omp plugin config set omp-bad-fseventsd <key> <value>`),
// declared once in package.json#omp.settings.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getPluginsLockfile } from "@oh-my-pi/pi-utils";
import pkg from "../package.json" with { type: "json" };
import type { Client } from "./scan.ts";

export const dataDir = path.join(getAgentDir(), "bad-fseventsd");
const file = (name: string) => path.join(dataDir, name);

export interface Settings {
	limitGB: number;
}

type SettingSchema = { type: "boolean" | "number"; default: boolean | number; env?: string };

/** `omp plugin config` value, else the declared env var, else the manifest default. */
export function loadSettings(lockfile = getPluginsLockfile()): Settings {
	let saved: Record<string, unknown> = {};
	try {
		saved = JSON.parse(fs.readFileSync(lockfile, "utf8")).settings?.[pkg.name] ?? {};
	} catch {
		// Not installed as a plugin (e.g. dropped into extensions/): defaults and env only.
	}
	const out: Record<string, unknown> = {};
	for (const [key, s] of Object.entries(pkg.omp.settings as Record<string, SettingSchema>)) {
		const raw = s.env ? process.env[s.env] : undefined;
		const fromEnv = raw === undefined ? undefined : s.type === "boolean" ? /^(1|true|yes|on)$/i.test(raw) : Number(raw);
		const value = saved[key] ?? fromEnv;
		out[key] = typeof value === typeof s.default && !Number.isNaN(value) ? value : s.default;
	}
	return out as unknown as Settings;
}

export interface State {
	memMB?: number;
	/** When memMB was measured. */
	at?: number;
	restart?: { at: number; lost: Client[] };
}

function readJson<T>(name: string, fallback: T): T {
	try {
		return { ...fallback, ...JSON.parse(fs.readFileSync(file(name), "utf8")) };
	} catch {
		return fallback;
	}
}

function writeJson(name: string, value: unknown): void {
	fs.mkdirSync(dataDir, { recursive: true });
	// Atomic replace: several omp processes may write the same file.
	const tmp = `${file(name)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	fs.renameSync(tmp, file(name));
}

export const loadState = (): State => readJson<State>("state.json", {});
export const updateState = (patch: State) => writeJson("state.json", { ...loadState(), ...patch });

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * One omp process measures at a time, so N open sessions do not run top N times.
 * ponytail: read-then-write lease, not a lock; two processes can both win one
 * tick. Measuring twice is harmless and the next tick settles it.
 */
export function tryLead(now: number, staleMs: number): boolean {
	const current = readJson<{ pid?: number; ts?: number }>("leader.json", {});
	const mine = current.pid === process.pid;
	const vacant = !current.pid || !current.ts || now - current.ts > staleMs || !alive(current.pid);
	if (!mine && !vacant) return false;
	writeJson("leader.json", { pid: process.pid, ts: now });
	return true;
}
