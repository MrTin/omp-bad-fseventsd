import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir, loadSettings, loadState, tryLead, updateState } from "../src/store.ts";

const lockfile = path.join(dataDir, "..", "omp-plugins.lock.json");
const writeLock = (settings: Record<string, unknown>) => {
	fs.mkdirSync(path.dirname(lockfile), { recursive: true });
	fs.writeFileSync(lockfile, JSON.stringify({ settings: { "omp-bad-fseventsd": settings } }));
};

afterEach(() => {
	fs.rmSync(lockfile, { force: true });
	delete process.env.OMP_BAD_FSEVENTSD_LIMIT_GB;
});

test("omp plugin config beats env, env beats default, junk falls back", () => {
	process.env.OMP_BAD_FSEVENTSD_LIMIT_GB = "3";
	expect(loadSettings(lockfile).limitGB).toBe(3);
	writeLock({ limitGB: 8 });
	expect(loadSettings(lockfile).limitGB).toBe(8);
	writeLock({ limitGB: "lots" });
	process.env.OMP_BAD_FSEVENTSD_LIMIT_GB = "soon";
	expect(loadSettings(lockfile).limitGB).toBe(0);
});

test("state updates merge, so a reading does not drop the last restart", () => {
	updateState({ restart: { at: 1, lost: [{ pid: 9, name: "vite", sessionId: "s" }] } });
	updateState({ memMB: 21504, at: 2 });
	expect(loadState()).toEqual({ memMB: 21504, at: 2, restart: { at: 1, lost: [{ pid: 9, name: "vite", sessionId: "s" }] } });
});

test("a live leader keeps the lease; a stale one loses it", () => {
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(path.join(dataDir, "leader.json"), JSON.stringify({ pid: process.ppid, ts: 1000 }));
	expect(tryLead(2000, 5000)).toBe(false);
	expect(tryLead(10_000, 5000)).toBe(true);
});
