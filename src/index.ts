// omp-bad-fseventsd: macOS fseventsd sometimes keeps every new file path it sees and
// never frees them: GBs of memory and a pinned core, until it is restarted. Agents
// that create and delete thousands of files (worktrees, installs, test fixtures)
// set it off. Restarting it can leave apps that watch files deaf, so nothing here
// restarts it without you:
//   - one omp process measures it every 10 minutes (top, no root)
//   - every interactive session warns when it is over the limit
//   - /fsnuke shows which apps hold an event stream, asks, then restarts it
//     through a root helper you install once (helper/omp-bad-fseventsd.sh)
//   - afterwards, a session whose own processes lost their stream is told so

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import { type Client, fmtMB, limitMB, pidList, topShares } from "./scan.ts";
import { loadSettings, loadState, tryLead, updateState } from "./store.ts";
import {
	AUDIT_LOG,
	HELPER,
	asAdmin,
	auditTail,
	bundledHelper,
	daemonMB,
	describe,
	helperState,
	installScript,
	readSnapshot,
	runHelper,
	uninstallScript,
} from "./system.ts";

const TICK_MS = 60_000;
const FIRST_TICK_MS = 15_000;
const MEASURE_MS = 10 * 60_000;
const REMIND_MS = 6 * 3600_000;
/** A restart notice older than this is not delivered to sessions that start later. */
const RESTART_NOTICE_MS = 3600_000;

const STOPPED: Record<string, string> = {
	"below-floor": "fseventsd is under 1 GB, the helper's floor; nothing to fix.",
	"rate-limited": "fseventsd was restarted less than 30 minutes ago; the helper allows one restart per 30 minutes.",
	"no-daemon": "fseventsd is not running (launchd should start it again).",
	"not-root": "the helper did not run as root; reinstall with /fsnuke install.",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const owner = (c: Client, mySession: string) =>
	c.sessionId === mySession ? ", started by this omp session" : c.sessionId ? ", started by another omp session" : "";

export default function badFseventsd(pi: ExtensionAPI) {
	if (process.platform !== "darwin") return;
	// Per session: the factory is rebound for every session.
	let warnedMB = 0;
	let warnedAt = 0;
	let noticeSeen = 0;

	const limit = () => limitMB(loadSettings().limitGB, os.totalmem());

	async function tick(ctx: ExtensionContext): Promise<void> {
		const now = Date.now();
		let state = loadState();
		if (now - (state.at ?? 0) >= MEASURE_MS && tryLead(now, MEASURE_MS * 3)) {
			const memMB = await daemonMB(pi.exec);
			if (memMB !== undefined) updateState({ memMB, at: now });
			state = loadState();
		}
		deliverRestartNotice(ctx, now);
		const { memMB } = state;
		if (!ctx.hasUI || !memMB || now - (state.at ?? 0) > MEASURE_MS * 3 || memMB < limit()) return;
		if (memMB < warnedMB * 2 && now - warnedAt < REMIND_MS) return;
		warnedMB = memMB;
		warnedAt = now;
		ctx.ui.notify(
			`fseventsd uses ${fmtMB(memMB)} (limit ${fmtMB(limit())}) and will not shrink on its own. ` +
				"/fsnuke restarts it after showing which apps watch files and may need a restart too.",
			"warning",
		);
	}

	/** Tell this session's agent about its processes that lost their event stream in the last restart. */
	function deliverRestartNotice(ctx: ExtensionContext, now: number): void {
		const r = loadState().restart;
		if (!r || r.at <= noticeSeen || now - r.at > RESTART_NOTICE_MS) return;
		noticeSeen = r.at;
		const mine = r.lost.filter(c => c.sessionId === ctx.sessionManager.getSessionId());
		if (mine.length === 0) return;
		pi.sendMessage(
			{
				customType: "bad-fseventsd.restarted",
				display: true,
				content: [
					"[bad-fseventsd] macOS fseventsd was restarted. These processes this session started were watching files and did not reconnect, so they no longer see file changes:",
					...mine.map(c => `- pid ${c.pid} ${c.name}`),
					"If you rely on one (dev server, watch-mode build or test), restart it.",
				].join("\n"),
			},
			{ deliverAs: "nextTurn" },
		);
	}

	async function nuke(ctx: ExtensionContext): Promise<void> {
		const helper = helperState();
		if (helper !== "installed") {
			ctx.ui.notify(`fsnuke: the root helper is ${helper}. Run /fsnuke install first.`, "warning");
			return;
		}
		const pre = await runHelper(pi.exec, "clients");
		if (pre.error) return stopped(ctx, pre.error);
		const me = ctx.sessionManager.getSessionId();
		const clients = await describe(pi.exec, pidList(pre.clients));
		const ok = await ctx.ui.confirm(
			`Restart fseventsd (${fmtMB(Number(pre.mem_mb))})?`,
			[
				"File operations keep working. Its event history is erased: Time Machine and sync apps rescan once.",
				clients.length === 0
					? "No app holds an event stream right now."
					: "These apps hold an event stream. Any that do not reconnect stop seeing file changes until restarted:",
				...clients.map(c => `  ${c.name} (pid ${c.pid}${owner(c, me)})`),
			].join("\n"),
		);
		if (!ok) return;
		// Spinner above the editor while the helper runs; a slash command gets no working row of its own.
		// Plain string lines, not a pi-tui component: pi-tui's exports change between omp versions.
		const started = Date.now();
		let frame = 0;
		const draw = () =>
			ctx.ui.setWidget("fsnuke", [
				`${SPINNER[frame++ % SPINNER.length]} fsnuke: restarting fseventsd (about 15 s)… ${Math.round((Date.now() - started) / 1000)} s`,
			]);
		draw();
		const timer = setInterval(draw, 100);
		const res = await runHelper(pi.exec, "restart").finally(() => {
			clearInterval(timer);
			ctx.ui.setWidget("fsnuke", undefined);
		});
		if (res.error) return stopped(ctx, res.error);

		const after = pidList(res.clients_after);
		const lost = await describe(
			pi.exec,
			pidList(res.clients_before).filter(p => !after.includes(p)),
		);
		const now = Date.now();
		updateState({ memMB: Number(res.new_mem_mb), at: now, restart: { at: now, lost } });
		const churn = topShares(await readSnapshot(os.homedir()), 6);
		ctx.ui.notify(
			[
				`fsnuke: fseventsd ${fmtMB(Number(res.mem_mb))} → ${fmtMB(Number(res.new_mem_mb))}.`,
				lost.length === 0
					? "Every app with an event stream reconnected."
					: `Did not reconnect (restart them if you rely on them): ${lost.map(c => `${c.name} (pid ${c.pid}${owner(c, me)})`).join(", ")}`,
				...(churn.length > 0
					? ["Where the recent file events came from:", ...churn.map(([dir, s]) => `  ${(s * 100).toFixed(0).padStart(3)}%  ${dir}`)]
					: []),
			].join("\n"),
			"info",
		);
		deliverRestartNotice(ctx, now);
	}

	function stopped(ctx: ExtensionContext, error: string): void {
		ctx.ui.notify(`fsnuke: ${STOPPED[error.split(" ")[0]] ?? error}`, "warning");
	}

	async function setup(ctx: ExtensionContext, action: "install" | "uninstall"): Promise<void> {
		const user = os.userInfo().username;
		const body =
			action === "install"
				? [
						`Installs a root-owned script at ${HELPER} and a sudoers rule that lets ${user} run exactly`,
						`\`${HELPER} clients\` and \`${HELPER} restart\` without a password, nothing else.`,
						"The script restarts fseventsd only above 1 GB, at most once per 30 minutes,",
						`and logs every call to ${AUDIT_LOG} and the system log.`,
						"macOS asks for your password once.",
					].join("\n")
				: `Removes ${HELPER}, its sudoers rule and its snapshot directory. ${AUDIT_LOG} stays.`;
		if (!(await ctx.ui.confirm(`fsnuke ${action}`, body))) return;
		const script =
			action === "install" ? installScript(user, fs.readFileSync(bundledHelper, "utf8")) : uninstallScript(user);
		const res = await asAdmin(pi.exec, script, `omp-bad-fseventsd wants to ${action} its fseventsd restart helper.`);
		if (res.code === 0) ctx.ui.notify(`fsnuke: ${action} done`, "info");
		else ctx.ui.notify(`fsnuke: ${action} failed: ${res.stderr.trim() || `exit ${res.code}`}`, "error");
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		ctx.setTimeout(() => void tick(ctx), FIRST_TICK_MS);
		ctx.setInterval(() => void tick(ctx), TICK_MS);
	});

	pi.registerCommand("fsnuke", {
		description: "Restart a runaway macOS fseventsd after showing what it affects: status | install | uninstall",
		handler: async (args, ctx) => {
			const sub = args.trim() || "restart";
			if (sub === "restart") return nuke(ctx);
			if (sub === "install" || sub === "uninstall") return setup(ctx, sub);
			const { memMB, at } = loadState();
			const lines = [
				`fseventsd: ${memMB ? `${fmtMB(memMB)}, measured ${Math.round((Date.now() - (at ?? 0)) / 60_000)} min ago` : "not measured yet"} (limit ${fmtMB(limit())})`,
				`helper: ${helperState()}`,
				...auditTail(5).map(l => `  ${l}`),
			];
			ctx.ui.notify(sub === "status" ? lines.join("\n") : "usage: /fsnuke [status|install|uninstall]", "info");
		},
	});
}
