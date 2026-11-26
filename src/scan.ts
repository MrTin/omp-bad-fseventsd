// Parsing and arithmetic. Pure: no I/O. Every behaviour change gets a case in test/scan.test.ts.

/** top's MEM column for `pid` ("21G", "512M+", "3648K") in MB. */
export function parseTopMem(out: string, pid: number): number | undefined {
	for (const line of out.split("\n")) {
		const [p, mem] = line.trim().split(/\s+/);
		if (Number(p) !== pid) continue;
		const m = mem?.match(/^([\d.]+)([BKMGT]?)[+-]?$/);
		if (!m) return undefined;
		const perMB: Record<string, number> = { "": 2 ** -20, B: 2 ** -20, K: 2 ** -10, M: 1, G: 2 ** 10, T: 2 ** 20 };
		return Math.round(Number(m[1]) * perMB[m[2]]);
	}
	return undefined;
}

/** Setting `limitGB`, or for 0: 5% of RAM, at least 2 GB. */
export const limitMB = (limitGB: number, ramBytes: number): number =>
	limitGB > 0 ? Math.round(limitGB * 1024) : Math.max(2048, Math.round((ramBytes / 2 ** 20) * 0.05));

export const fmtMB = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

/** The helper's `key=value` lines. */
export function parseKv(out: string): Record<string, string> {
	const kv: Record<string, string> = {};
	for (const line of out.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) kv[line.slice(0, eq)] = line.slice(eq + 1).trim();
	}
	return kv;
}

export const pidList = (s = ""): number[] => s.split(/\s+/).filter(Boolean).map(Number);

export interface Client {
	pid: number;
	name: string;
	/** omp session whose bash tool started it (inherited PI_SESSION_ID). */
	sessionId?: string;
}

/** `ps -o pid=,comm=` and `ps -wwE -o pid=,command=` output for the same pids. */
export function parseClients(names: string, withEnv: string): Client[] {
	const sessions = new Map<number, string>();
	for (const line of withEnv.split("\n")) {
		const m = line.match(/^\s*(\d+)\s.*\sPI_SESSION_ID=([\w-]+)/);
		if (m) sessions.set(Number(m[1]), m[2]);
	}
	const out: Client[] = [];
	for (const line of names.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
		if (!m) continue;
		const pid = Number(m[1]);
		out.push({ pid, name: m[2].slice(m[2].lastIndexOf("/") + 1), sessionId: sessions.get(pid) });
	}
	return out;
}

// fseventsd's on-disk history, one gzip file per batch. Inside: pages of
// magic ("1SLD".."3SLD"), u32, u32 page length including this 12-byte header;
// then records of path NUL + a fixed tail (event id, flags, node id, ...).
const RECORD_TAIL: Record<string, number> = { "1SLD": 12, "2SLD": 20, "3SLD": 24 };
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder();

/** Every path in one gunzipped history file. Paths are volume-relative, without the leading slash. */
export function* historyPaths(buf: Uint8Array): Generator<string> {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	for (let page = 0; page + 12 <= buf.length; ) {
		const tail = RECORD_TAIL[latin1.decode(buf.subarray(page, page + 4))];
		const end = page + view.getUint32(page + 8, true);
		if (!tail || end > buf.length || end <= page) return;
		for (let i = page + 12; i < end; ) {
			const nul = buf.indexOf(0, i);
			if (nul < 0 || nul >= end) return;
			yield utf8.decode(buf.subarray(i, nul));
			i = nul + 1 + tail;
		}
		page = end;
	}
}

/** Folds a history path to a 3-level directory: `~/projects/app`, `$TMPDIR/x/y`, `/private/var/db`. */
export function churnDir(relPath: string, home: string): string {
	let p = `/${relPath}`.replace(/^\/private\/var\/folders\/[^/]+\/[^/]+\/T(?=\/|$)/, () => "$TMPDIR");
	if (p === home || p.startsWith(`${home}/`)) p = `~${p.slice(home.length)}`;
	const parts = p.split("/");
	return parts.slice(0, parts[0] === "" ? 4 : 3).join("/");
}

/** Highest counts first, as [dir, share of total]. */
export function topShares(counts: Map<string, number>, n: number): [string, number][] {
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	return [...counts]
		.sort(([, a], [, b]) => b - a)
		.slice(0, n)
		.map(([dir, c]) => [dir, c / total]);
}
