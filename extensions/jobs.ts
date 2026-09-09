// jobs.ts — background job runner with early-exit waiting and ::progress parsing.
//
// Agents waste wall-clock blocking on `nohup cmd &` + a long fixed timeout, or
// hand-roll fragile event/cron re-wake schemes. Instead, job_wait resolves the
// INSTANT the process exits (or a finish-condition regex matches) — pi awaits
// the tool promise, so the agent's turn resumes immediately.
//
// Lazy activation (see pi docs "Dynamic Tool Loading"): only job_run is active
// at session start; job_wait/job_list/job_logs/job_stop activate additively the
// moment a job_run call actually creates a job. That cuts baseline tool-schema
// cost from 5 tools to 1 for sessions that never background anything.
//
// Footer contract: the running-job count is published on globalThis
// (__piJobsRunning) on every transition, so the current-prompt extension can
// keep its spinner up while background jobs outlive the agent run. In-process
// only, same-process extensions — no disk I/O, and a missing reader (or a
// missing publisher) just means the footer doesn't reflect jobs.
//
// Install anywhere: ~/.pi/agent/extensions/jobs.ts (global) or
// <project>/.pi/extensions/jobs.ts (project-local). A project-local copy never
// double-registers when a global copy also exists (global wins — see the guard
// at the top of the factory). Reversible: delete this file + /reload.

import { type ChildProcess, spawn } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	type WriteStream,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_MEM_LINES = 1000;
const IS_WIN = process.platform === "win32";
const PROGRESS_RE =
	/::progress\s+(?:(\d+(?:\.\d+)?)\s*%|(\d+)\s*\/\s*(\d+))\s*(.*)$/;
const LAZY_TOOL_NAMES = ["job_wait", "job_list", "job_logs", "job_stop"];
const JOB_STOP_GRACE_MS = 4000;

interface Progress {
	pct: number;
	done?: number;
	total?: number;
	msg?: string;
}

interface Job {
	id: string;
	command: string;
	cwd?: string;
	title?: string;
	pid?: number;
	progress?: Progress;
	status: "running" | "done" | "error" | "stopped";
	exitCode?: number | null;
	signal?: string | null;
	startedAt: number;
	endedAt?: number;
	child: ChildProcess;
	log: WriteStream;
	logPath: string;
	lines: string[];
	lineCount: number;
	lineListeners: Set<(line: string) => void>;
}

function fmtAge(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

function text(msg: string) {
	return { content: [{ type: "text", text: msg }], details: undefined };
}

function parseProgress(line: string): Progress | null {
	const m = PROGRESS_RE.exec(line);
	if (!m) return null;
	const msg = (m[4] ?? "").trim();
	if (m[1] !== undefined) {
		return { pct: parseFloat(m[1]), ...(msg ? { msg } : {}) };
	}
	const done = parseInt(m[2], 10);
	const total = parseInt(m[3], 10);
	const pct = total > 0 ? (done / total) * 100 : 0;
	return { pct, done, total, ...(msg ? { msg } : {}) };
}

function fmtPct(pct: number): string {
	return Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
}

function progressText(job: Job, now = Date.now()): string | null {
	const p = job.progress;
	if (!p) return null;
	let s =
		p.done !== undefined && p.total !== undefined
			? `${fmtPct(p.pct)}% (${p.done}/${p.total})`
			: `${fmtPct(p.pct)}%`;
	const sinceStart = now - job.startedAt;
	if (p.pct > 0 && p.pct < 100 && sinceStart > 0) {
		const totalEst = sinceStart / (p.pct / 100);
		const remaining = totalEst - sinceStart;
		if (remaining > 0) s += ` ETA ${fmtAge(remaining)}`;
	}
	if (p.msg) s += ` — ${p.msg}`;
	return s;
}

function summary(job: Job, now = Date.now()): string {
	const icon =
		job.status === "running"
			? ">"
			: job.status === "done"
				? "ok"
				: job.status === "stopped"
					? "-"
					: "x";
	const name = job.title ?? job.command.slice(0, 80);
	const duration = fmtAge((job.endedAt ?? now) - job.startedAt);
	let s = `${icon} [${job.status}] ${name} — ${job.lineCount} lines, ${duration}`;
	if (job.status === "running") {
		const pt = progressText(job, now);
		if (pt) s += ` · ${pt}`;
	} else {
		if (job.exitCode !== undefined && job.exitCode !== null)
			s += ` exit=${job.exitCode}`;
		if (job.signal) s += ` signal=${job.signal}`;
	}
	s += ` (job ${job.id})`;
	return s;
}

function tailLines(job: Job, n: number): string[] {
	try {
		const raw = readFileSync(job.logPath, "utf8").split("\n");
		if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
		return raw.slice(-n);
	} catch {
		return job.lines.slice(-n);
	}
}

// --- cross-platform sh -------------------------------------------------------
// The pi host's PATH may lack Git's usr/bin, so bare spawn("sh") dies with
// ENOENT on Windows even though the bash tool (running inside git bash) finds
// it fine. Resolve absolute-first on Windows.

let SH_BIN_DIR: string | null = null;

function resolveSh(): string {
	if (!IS_WIN) return "sh";
	const pf = process.env.ProgramFiles ?? "C:\\Program Files";
	const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
	const localApp = process.env.LOCALAPPDATA ?? "";
	const candidates = [
		join(pf, "Git", "usr", "bin", "sh.exe"),
		join(pf, "Git", "bin", "sh.exe"),
		join(pf86, "Git", "usr", "bin", "sh.exe"),
		localApp ? join(localApp, "Programs", "Git", "usr", "bin", "sh.exe") : "",
	].filter(Boolean);
	for (const c of candidates) {
		if (existsSync(c)) {
			SH_BIN_DIR = dirname(c);
			return c;
		}
	}
	return "sh";
}

function childEnv(): NodeJS.ProcessEnv {
	if (!IS_WIN || !SH_BIN_DIR) return { ...process.env };
	const oldPath = process.env.PATH ?? process.env.Path ?? "";
	return { ...process.env, PATH: `${SH_BIN_DIR};${oldPath}` };
}

function killJob(job: Job, sig: NodeJS.Signals) {
	try {
		if (IS_WIN && job.pid !== undefined) {
			// child.kill only hits sh.exe, orphaning coreutils grandchildren —
			// taskkill /T /F kills the whole tree. Both SIGTERM and SIGKILL
			// map to the same forceful tree-kill for background jobs.
			spawn("taskkill", ["/PID", String(job.pid), "/T", "/F"], {
				stdio: "ignore",
			});
			return;
		}
		if (!IS_WIN && job.pid !== undefined) {
			process.kill(-job.pid, sig); // whole process group
			return;
		}
		job.child.kill(sig);
	} catch {
		try {
			job.child.kill(sig);
		} catch {
			// already dead
		}
	}
}

export default function (pi: ExtensionAPI) {
	// Global double-load guard: global copy wins, project copy returns early.
	try {
		const globalPath = join(
			process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
			"extensions",
			"jobs.ts",
		);
		let self = "";
		try {
			self = fileURLToPath(import.meta.url);
		} catch {
			self = "";
		}
		const norm = (p: string) => p.toLowerCase().replace(/\\/g, "/");
		if (self && norm(self) !== norm(globalPath) && existsSync(globalPath)) return;
	} catch {
		// guard failure must never block registration
	}

	const jobs = new Map<string, Job>();
	let nextId = 1;

	try {
		mkdirSync(join(tmpdir(), "pi-jobs"), { recursive: true });
	} catch {
		// best-effort; spawn will surface real failures per job
	}

	const SH = resolveSh();

	function activateJobTools() {
		const active = pi.getActiveTools();
		const missing = LAZY_TOOL_NAMES.filter((name) => !active.includes(name));
		if (missing.length > 0)
			pi.setActiveTools([...new Set([...active, ...missing])]);
	}

	// Publish the live running-job count for same-process readers (the
	// current-prompt footer keeps its spinner up while jobs outlive the run).
	// Best-effort: footer accuracy must never break job management.
	function publishRunning() {
		try {
			let running = 0;
			for (const job of jobs.values()) {
				if (job.status === "running") running++;
			}
			(globalThis as any).__piJobsRunning = running;
		} catch {
			// ignore — footer hint only
		}
	}

	function finalize(
		job: Job,
		status: Job["status"],
		code: number | null,
		signal: string | null,
	) {
		if (job.status !== "running") return;
		job.status = status;
		job.exitCode = code;
		job.signal = signal;
		job.endedAt = Date.now();
		try {
			job.log.end();
		} catch {
			// already closed
		}
		publishRunning();
	}

	function pushLine(job: Job, line: string) {
		job.lineCount++;
		job.lines.push(line);
		if (job.lines.length > MAX_MEM_LINES) job.lines.shift();
		const p = parseProgress(line);
		if (p) job.progress = p;
		for (const listener of [...job.lineListeners]) {
			try {
				listener(line);
			} catch {
				// a bad listener must not break streaming
			}
		}
	}

	function attachStream(job: Job, stream: NodeJS.ReadableStream) {
		let partial = "";
		stream.on("data", (buf: Buffer) => {
			try {
				job.log.write(buf);
			} catch {
				// log write failure must not break the job
			}
			partial += buf.toString("utf8");
			let idx: number;
			while ((idx = partial.indexOf("\n")) >= 0) {
				pushLine(job, partial.slice(0, idx).replace(/\r$/, ""));
				partial = partial.slice(idx + 1);
			}
		});
		stream.on("end", () => {
			if (partial.length > 0) pushLine(job, partial.replace(/\r$/, ""));
		});
	}

	pi.registerTool({
		name: "job_run",
		label: "Run Background Job",
		description:
			"Start a detached background shell command and return a job id at once. Use job_wait to block until it finishes.",
		promptGuidelines: [
			"Use job_run + job_wait instead of bash nohup/& with long fixed timeouts when running background commands.",
			"Always pass a job_run title summarizing what the job does or why it exists (how it is identified in job_wait/job_list), not a restatement of the command.",
			"For long jobs, print ::progress <done>/<total> or ::progress <pct>% marker lines with an optional trailing message; the LATEST such line wins and shows % + ETA in job_wait/job_list.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command, run via sh -c" }),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory (default: current directory)",
				}),
			),
			title: Type.Optional(
				Type.String({ description: "Short title identifying the job" }),
			),
		}),
		async execute(
			_toolCallId: string,
			params: any,
			_signal: any,
			_onUpdate: any,
			ctx: any,
		) {
			const id = String(nextId++);
			const logPath = join(tmpdir(), "pi-jobs", `job-${id}.log`);
			const log = createWriteStream(logPath, { flags: "w" });
			const child = spawn(SH, ["-c", params.command], {
				cwd: params.cwd ?? ctx?.cwd ?? process.cwd(),
				stdio: ["ignore", "pipe", "pipe"],
				detached: !IS_WIN,
				env: childEnv(),
			});
			const job: Job = {
				id,
				command: params.command,
				...(params.cwd ? { cwd: params.cwd } : {}),
				...(params.title ? { title: params.title } : {}),
				pid: child.pid,
				status: "running",
				startedAt: Date.now(),
				child,
				log,
				logPath,
				lines: [],
				lineCount: 0,
				lineListeners: new Set(),
			};
			jobs.set(id, job);
			publishRunning();
			if (child.stdout) attachStream(job, child.stdout);
			if (child.stderr) attachStream(job, child.stderr);
			child.on("close", (code: number | null, signal: string | null) => {
				finalize(job, code === 0 ? "done" : "error", code, signal);
			});
			child.on("error", (err: Error) => {
				const line = `[spawn error] ${err.message}`;
				try {
					job.log.write(line + "\n");
				} catch {
					// ignore
				}
				pushLine(job, line);
				finalize(job, "error", null, null);
			});
			activateJobTools();
			const name = params.title ?? params.command.slice(0, 80);
			return text(
				`Job ${id} started: ${name}\nLog: ${logPath}\nCall job_wait { id: "${id}" } to block until it finishes.`,
			);
		},
	});

	pi.registerTool({
		name: "job_wait",
		label: "Wait For Job",
		description:
			"Block until a background job exits, an output regex matches, or a timeout elapses. Resolves the instant the condition hits.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id from job_run" }),
			until: Type.Optional(
				Type.String({
					description:
						"Optional regex; resolve early when a new output line matches (job keeps running)",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Integer({
					description:
						"Max wait in ms (default 600000). Expiry does NOT kill the job.",
				}),
			),
			tail: Type.Optional(
				Type.Integer({ description: "Output lines to include (default 40)" }),
			),
		}),
		async execute(
			_toolCallId: string,
			params: any,
			signal: any,
			onUpdate: any,
			_ctx: any,
		) {
			const job = jobs.get(params.id);
			if (!job) return text(`No job #${params.id}. Use job_list.`);
			const timeoutMs = params.timeoutMs ?? 600_000;
			const tailN = params.tail ?? 40;

			let re: RegExp | null = null;
			if (params.until !== undefined) {
				try {
					re = new RegExp(params.until);
				} catch {
					return text(
						`job_wait: invalid regex /${params.until}/ (no wait, job still running).`,
					);
				}
			}

			const tailBlock = () => {
				const tail = tailLines(job, tailN);
				return `${summary(job)}\n--- output (last ${tail.length}) ---\n${tail.join("\n")}`;
			};

			if (job.status !== "running") return text(`Job finished.\n${tailBlock()}`);
			if (re && job.lines.some((line) => re!.test(line))) {
				return text(
					`Matched /${params.until}/ (job still running).\n${tailBlock()}`,
				);
			}

			const outcome = await new Promise<"exit" | "match" | "timeout" | "abort">(
				(resolve) => {
					let done = false;
					const finish = (o: "exit" | "match" | "timeout" | "abort") => {
						if (done) return;
						done = true;
						clearTimeout(timer);
						clearInterval(interval);
						job.child.removeListener("close", onClose);
						if (onLine) job.lineListeners.delete(onLine);
						signal?.removeEventListener?.("abort", onAbort);
						resolve(o);
					};
					const onClose = () => finish("exit");
					let onLine: ((line: string) => void) | null = null;
					if (re) {
						const rx: RegExp = re;
						onLine = (line: string) => {
							try {
								if (rx.test(line)) finish("match");
							} catch {
								// ignore test errors mid-stream
							}
						};
						job.lineListeners.add(onLine);
					}
					const timer = setTimeout(() => finish("timeout"), timeoutMs);
					const onAbort = () => finish("abort");
					signal?.addEventListener?.("abort", onAbort, { once: true });
					job.child.once("close", onClose);

					if (typeof onUpdate === "function") {
						const tick = () => {
							const elapsed = Date.now() - job.startedAt;
							const pt = progressText(job);
							const last =
								job.lines.length > 0
									? job.lines[job.lines.length - 1].slice(0, 120)
									: "";
							const name = job.title ?? job.command.slice(0, 80);
							try {
								onUpdate({
									content: [
										{
											type: "text",
											text: `${name}\nwaiting ${fmtAge(elapsed)} · ${pt ?? `${job.lineCount} lines`}\n${last}`,
										},
									],
									details: {
										command: job.command,
										title: job.title,
										elapsedMs: elapsed,
										lineCount: job.lineCount,
										status: job.status,
										progress: job.progress,
									},
								});
							} catch {
								// onUpdate failure must not break the wait
							}
						};
						tick();
						var interval: NodeJS.Timeout = setInterval(tick, 2000);
						(interval as any)?.unref?.();
					} else {
						var interval: NodeJS.Timeout = setInterval(() => {}, 1 << 30);
						clearInterval(interval);
					}
				},
			);

			if (outcome === "exit") return text(`Job finished.\n${tailBlock()}`);
			if (outcome === "match")
				return text(
					`Matched /${params.until}/ (job still running).\n${tailBlock()}`,
				);
			if (outcome === "abort") return text(`Wait aborted.\n${tailBlock()}`);
			return text(
				`Still running after ${fmtAge(timeoutMs)} (not killed).\n${tailBlock()}`,
			);
		},
	});

	pi.registerTool({
		name: "job_list",
		label: "List Jobs",
		description:
			"List all background jobs with status, runtime, and line counts.",
		parameters: Type.Object({}),
		async execute() {
			if (jobs.size === 0) return text("No jobs.");
			const sorted = [...jobs.values()].sort(
				(a, b) => Number(a.id) - Number(b.id),
			);
			return text(sorted.map((j) => summary(j)).join("\n"));
		},
	});

	pi.registerTool({
		name: "job_logs",
		label: "Job Logs",
		description: "Show the tail of a background job's captured output.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id from job_run" }),
			tail: Type.Optional(
				Type.Integer({ description: "Output lines to show (default 100)" }),
			),
		}),
		async execute(_toolCallId: string, params: any) {
			const job = jobs.get(params.id);
			if (!job) return text(`No job #${params.id}. Use job_list.`);
			const tailN = params.tail ?? 100;
			const tail = tailLines(job, tailN);
			return text(
				`${summary(job)}\nLog: ${job.logPath}\n--- output (last ${tail.length}) ---\n${tail.join("\n")}`,
			);
		},
	});

	pi.registerTool({
		name: "job_stop",
		label: "Stop Job",
		description:
			"Stop a running background job (SIGTERM, then SIGKILL after a grace period).",
		parameters: Type.Object({
			id: Type.String({ description: "Job id from job_run" }),
		}),
		async execute(_toolCallId: string, params: any) {
			const job = jobs.get(params.id);
			if (!job) return text(`No job #${params.id}. Use job_list.`);
			if (job.status !== "running")
				return text(`Job #${params.id} is already ${job.status}.`);
			killJob(job, "SIGTERM");
			const exited = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => {
					job.child.removeListener("close", onClose);
					resolve(false);
				}, JOB_STOP_GRACE_MS);
				(timer as any)?.unref?.();
				const onClose = () => {
					clearTimeout(timer);
					resolve(true);
				};
				job.child.once("close", onClose);
			});
			let sigkill = false;
			if (!exited) {
				killJob(job, "SIGKILL");
				sigkill = true;
			}
			if (job.status === "running") {
				// close never fired (e.g. Windows taskkill detection lag)
				finalize(job, "stopped", null, "SIGTERM");
			} else {
				// The close handler labeled the killed process "error", but the
				// exit was user-initiated — "stopped" is the truthful label.
				job.status = "stopped";
				publishRunning();
			}
			return text(`Job #${params.id} stopped${sigkill ? " (SIGKILL)" : ""}.`);
		},
	});

	pi.on("session_start", async () => {
		const active = pi.getActiveTools();
		const filtered = active.filter((name) => !LAZY_TOOL_NAMES.includes(name));
		if (filtered.length !== active.length)
			pi.setActiveTools([...new Set(filtered)]);
	});
}
