import { describe, expect, test } from "bun:test";
import { churnDir, historyPaths, limitMB, parseClients, parseKv, parseTopMem, topShares } from "../src/scan.ts";

const HOME = "/Users/someone";

/** One history page as fseventsd writes it: magic, u32, u32 length, then path NUL + fixed tail per record. */
function page(magic: string, tail: number, paths: string[]): Uint8Array {
	const enc = new TextEncoder();
	const records = paths.map(p => [...enc.encode(p), 0, ...new Array(tail).fill(7)]).flat();
	const out = new Uint8Array(12 + records.length);
	out.set(enc.encode(magic), 0);
	new DataView(out.buffer).setUint32(8, out.length, true);
	out.set(records, 12);
	return out;
}

describe("top memory", () => {
	const top = (mem: string) => `PID  MEM\n344  ${mem}\n`;

	test("units, including top's trailing growth marker", () => {
		expect(parseTopMem(top("21G"), 344)).toBe(21504);
		expect(parseTopMem(top("1.5G+"), 344)).toBe(1536);
		expect(parseTopMem(top("512M"), 344)).toBe(512);
		expect(parseTopMem(top("3648K-"), 344)).toBe(4);
	});

	test("another pid or an unreadable value gives nothing", () => {
		expect(parseTopMem(top("21G"), 345)).toBeUndefined();
		expect(parseTopMem(top("n/a"), 344)).toBeUndefined();
	});
});

describe("limit", () => {
	const GB = 2 ** 30;

	test("auto is 5% of RAM, never under 2 GB", () => {
		expect(limitMB(0, 16 * GB)).toBe(2048);
		expect(limitMB(0, 48 * GB)).toBe(2458);
		expect(limitMB(0, 128 * GB)).toBe(6554);
	});

	test("a set limit wins, whatever the RAM", () => {
		expect(limitMB(1.5, 128 * GB)).toBe(1536);
	});
});

test("helper output: values keep their spaces and equals signs", () => {
	expect(parseKv("mem_mb=21504\nclients=415 16963 \nerror=rate-limited retry_in_sec=60\n")).toEqual({
		mem_mb: "21504",
		clients: "415 16963",
		error: "rate-limited retry_in_sec=60",
	});
});

test("clients: names from comm with spaces, omp session from the environment", () => {
	const names = "  415 /usr/sbin/cfprefsd\n78716 /Applications/Raycast.app/Contents/MacOS/Raycast Backend\n";
	const withEnv =
		"  415 /usr/sbin/cfprefsd agent\n" +
		"78716 node vite.js --port 5173 HOME=/Users/someone PI_SESSION_ID=0f3c-41aa PATH=/usr/bin\n";
	expect(parseClients(names, withEnv)).toEqual([
		{ pid: 415, name: "cfprefsd", sessionId: undefined },
		{ pid: 78716, name: "Raycast Backend", sessionId: "0f3c-41aa" },
	]);
});

describe("history", () => {
	test("reads every record across pages of different versions", () => {
		const a = page("3SLD", 24, ["Users/someone/a", "private/tmp/b"]);
		const b = page("1SLD", 12, ["Users/someone/c"]);
		const buf = new Uint8Array([...a, ...b]);
		expect([...historyPaths(buf)]).toEqual(["Users/someone/a", "private/tmp/b", "Users/someone/c"]);
	});

	test("stops at an unknown magic or a truncated page instead of reading garbage", () => {
		const good = page("2SLD", 20, ["x/y"]);
		expect([...historyPaths(new Uint8Array([...good, ...page("9XYZ", 4, ["z"])]))]).toEqual(["x/y"]);
		expect([...historyPaths(good.subarray(0, good.length - 5))]).toEqual([]);
	});

	test("paths fold to three levels, with home and the per-user temp dir named", () => {
		expect(churnDir("Users/someone/projects/app/frontend/node_modules/x", HOME)).toBe("~/projects/app");
		expect(churnDir("private/var/folders/m7/abc123/T/vitest-1/a/b", HOME)).toBe("$TMPDIR/vitest-1/a");
		expect(churnDir("private/var/db/appinstalld/x", HOME)).toBe("/private/var/db");
		expect(churnDir("Users/someoneelse/x/y/z", HOME)).toBe("/Users/someoneelse/x");
	});

	test("shares are of the total, largest first", () => {
		const counts = new Map([
			["~/a", 1],
			["~/b", 3],
			["~/c", 4],
		]);
		expect(topShares(counts, 2)).toEqual([
			["~/c", 0.5],
			["~/b", 0.375],
		]);
	});
});
