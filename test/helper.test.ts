// The root helper and the script that installs it. Nothing here needs root.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bundledHelper, installScript } from "../src/system.ts";

const run = (cmd: string[]) => {
	const p = Bun.spawnSync(cmd);
	return { code: p.exitCode, out: p.stdout.toString() };
};

test("the helper parses, and refuses to do anything without root", () => {
	expect(run(["sh", "-n", bundledHelper]).code).toBe(0);
	expect(run(["sh", bundledHelper, "restart"])).toEqual({ code: 77, out: "error=not-root\n" });
});

test("install refuses user names that could inject into the sudoers rule", () => {
	for (const user of ["ms ALL=(ALL) NOPASSWD: ALL #", "ms'; rm -rf /; '", "../x", ""]) {
		expect(() => installScript(user, "#!/bin/sh\n")).toThrow();
	}
});

test.skipIf(!fs.existsSync("/usr/sbin/visudo"))("the sudoers rule it writes is valid and grants only the two commands", () => {
	const script = installScript("someone", fs.readFileSync(bundledHelper, "utf8"));
	const rule = script.match(/^echo '(.*)' >"\$rule"$/m)?.[1];
	expect(rule).toBe(
		"someone ALL=(root) NOPASSWD: /Library/PrivilegedHelperTools/omp-bad-fseventsd clients, /Library/PrivilegedHelperTools/omp-bad-fseventsd restart",
	);
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sudoers-")), "rule");
	fs.writeFileSync(file, `${rule}\n`);
	expect(run(["/usr/sbin/visudo", "-cf", file]).code).toBe(0);
});

test("the installed helper is byte for byte the bundled one, so `helper: outdated` stays accurate", () => {
	const helper = fs.readFileSync(bundledHelper, "utf8");
	const script = installScript("someone", helper);
	// Run only the heredoc that writes the helper, into a temp file instead of /Library.
	const start = script.indexOf('cat >"$tmp"');
	const fragment = script.slice(start, script.indexOf("\nOMP_BAD_FSEVENTSD_HELPER\n", start) + 25);
	const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "helper-")), "helper");
	expect(run(["sh", "-c", `tmp='${out}'\n${fragment}\n`]).code).toBe(0);
	expect(fs.readFileSync(out, "utf8")).toBe(helper);
});
