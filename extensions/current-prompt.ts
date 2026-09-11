// current-prompt.ts — show what a tab is doing at a glance: <context> › <label>.
//
// WARNING (strict gate, deliberate UX): on a fresh pi instance no context is
// captured yet, so the first submitted prompt PAUSES and REQUIRES describing
// the context before it runs — even "commit all changes" becomes understandable
// from the tab. Cancel the question and the prompt does NOT run (typed text is
// kept in the editor). Set/change/clear any time with `/context [text|clear]`.
//
// Renders `<state> <context> › <label>` to the terminal title and the pi footer
// status (key "current-prompt"): a braille spinner while working, `?` while
// ask_user_question awaits an answer, `✓` when idle. When background work —
// async subagents (via pi-subagents) or background jobs (via jobs.ts) — is
// still running after the main agent settles, a warning-colored spinner with
// "N subagents running" / "N jobs running" continues instead of the ✓.
//
// The idle state is never unwatched: a fast poll confirms background work is
// really gone (consecutive zero-scans) before showing the ✓, and a slow watch
// keeps re-scanning while idle so late-spawning work re-arms the spinner
// instead of wedging the ✓ forever.
//
// Subagent awareness reads pi-subagents' on-disk contract directly (it does NOT
// import pi-subagents internals — that would be version-fragile and side-effect
// the whole extension). Job awareness reads jobs.ts' in-process running count
// (globalThis.__piJobsRunning) — same-process extensions, no disk I/O.
//
// Install anywhere: ~/.pi/agent/extensions/current-prompt.ts (global) or
// <project>/.pi/extensions/current-prompt.ts (project-local); the global copy
// wins when both exist (double-load guard). Reload with /reload.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "@earendil-works/pi-ai/compat";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Static glyph for the footer status. That channel force-repaints the TUI
// (ui.requestRender, no diffing), so it must not change every tick; the
// animated frame goes on the tab title, which is a cheap OSC write.
const STATIC_MARK = SPINNER[0];
const MAX_LEN = 100;
const CONTEXT_MAX_LEN = 60;
const SUMMARIZE_MIN_LEN = 80;
const STATUS_KEY = "current-prompt";
const SEP = " › ";
const SUBAGENT_FRAME_MS = 120;
const SUBAGENT_SCAN_MS = 1200;
const SUBAGENT_STALE_MS = 6 * 60 * 60 * 1000;
// Slow re-scan while the footer claims idle: catches work that spawns after the
// ✓ is already shown. Cheap (one dir listing) — must stay unref'd, like the rest.
const IDLE_WATCH_MS = 2000;
// A lone zero scan proves nothing (mid-spawn status.json gap, torn dir listing)
// — only settle to ✓ after this many consecutive zero scans.
const IDLE_ZERO_CONFIRM = 2;
// pi-subagents' own terminal set (see its stale-run-reconciler) plus
// "completed" (sibling status shapes). Anything else — including a missing or
// future-unknown state — counts as active: fail to the spinner, never to the ✓.
const TERMINAL_SUBAGENT_STATES = new Set([
	"complete",
	"completed",
	"failed",
	"partial",
	"paused",
	"stopped",
	"rejected",
]);

const SUMMARY_INSTRUCTION =
	"Summarize the following user request as a terse task label of 3-7 words. Respond with ONLY the label: no quotes, no punctuation at the end, no preamble.\n\nRequest:\n";

function shorten(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= max) return collapsed;
	return collapsed.slice(0, max - 1) + "…";
}

// --- subagent on-disk contract (mirrors pi-subagents, do not import it) ------

function sanitizeScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

function subagentTempScopeId(): string {
	const getuid = (process as any).getuid?.bind(process);
	if (typeof getuid === "function") return `uid-${getuid()}`;
	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = process.env[key];
		if (value) return `user-${sanitizeScopeSegment(value)}`;
	}
	try {
		const username = os.userInfo().username;
		if (username) return `user-${sanitizeScopeSegment(username)}`;
	} catch {
		// fall through to home-directory scoping
	}
	const home = process.env.USERPROFILE ?? process.env.HOME;
	if (home) return `home-${sanitizeScopeSegment(home)}`;
	try {
		const fallback = os.homedir();
		if (fallback) return `home-${sanitizeScopeSegment(fallback)}`;
	} catch {
		// last-resort shared scope
	}
	return "shared";
}

let cachedSubagentDirs: { runs: string; results: string } | null = null;

function subagentDirs(): { runs: string; results: string } {
	if (!cachedSubagentDirs) {
		const override = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
		const base = override
			? path.resolve(override)
			: path.join(os.tmpdir(), `pi-subagents-${subagentTempScopeId()}`);
		cachedSubagentDirs = {
			runs: path.join(base, "async-subagent-runs"),
			results: path.join(base, "async-subagent-results"),
		};
	}
	return cachedSubagentDirs;
}

function normSessionId(value: string): string {
	return value.replace(/\\/g, "/").toLowerCase();
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		if (err?.code === "ESRCH") return false;
		return true; // alive or unknown — NEVER hide a real run
	}
}

interface BackgroundCount {
	subagents: number;
	jobs: number;
}

function countRunningJobs(): number {
	try {
		const n = (globalThis as any).__piJobsRunning;
		return typeof n === "number" && n > 0 ? Math.floor(n) : 0;
	} catch {
		return 0; // jobs.ts absent — subagents alone still drive the footer
	}
}

// null = the scan failed outright and proved nothing. Callers hold the previous
// frame and do NOT advance the idle zero-streak — a scan glitch must never wedge a ✓.
function scanBackground(sessionIds: string[]): BackgroundCount | null {
	let subagents = 0;
	try {
		// Without session ids ownership can't be attributed, so subagents stay
		// uncounted — same-process jobs need no attribution and still count.
		const owned =
			sessionIds.length > 0 ? new Set(sessionIds.map(normSessionId)) : null;
		const { runs, results } = subagentDirs();
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(runs, { withFileTypes: true });
		} catch {
			return null; // unreadable dir tells us nothing — never fail to ✓
		}
		for (const entry of entries) {
			try {
				if (!entry.isDirectory()) continue;
				const statusPath = path.join(runs, entry.name, "status.json");
				let mtimeMs = 0;
				try {
					mtimeMs = fs.statSync(statusPath).mtimeMs;
				} catch {
					continue; // missing/half-written/mid-rename — skip this tick
				}
				if (mtimeMs < Date.now() - SUBAGENT_STALE_MS) continue; // can't be live
				const raw = fs.readFileSync(statusPath, "utf8");
				const status = JSON.parse(raw) as {
					state?: unknown;
					sessionId?: unknown;
					runId?: unknown;
					pid?: unknown;
				};
				if (
					typeof status.state === "string" &&
					TERMINAL_SUBAGENT_STATES.has(status.state)
				)
					continue;
				// Missing/unknown state counts as active: a future pi-subagents
				// state must fail to the spinner, never to the ✓.
				if (
					owned === null ||
					typeof status.sessionId !== "string" ||
					!owned.has(normSessionId(status.sessionId))
				)
					continue;
				const runId =
					typeof status.runId === "string" && status.runId
						? status.runId
						: entry.name;
				if (fs.existsSync(path.join(results, `${runId}.json`))) continue; // already finished
				if (typeof status.pid === "number" && !pidIsAlive(status.pid)) continue;
				subagents++;
			} catch {}
		}
	} catch {
		return null; // a scan glitch proves nothing — never fail to the ✓
	}
	return { subagents, jobs: countRunningJobs() };
}

export default function (pi: ExtensionAPI) {
	// Global double-load guard FIRST: global copy wins, project copy returns early.
	try {
		const globalPath = path.join(
			process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
			"extensions",
			"current-prompt.ts",
		);
		let self = "";
		try {
			self = fileURLToPath(import.meta.url);
		} catch {
			self = "";
		}
		const norm = (p: string) => p.toLowerCase().replace(/\\/g, "/");
		if (self && norm(self) !== norm(globalPath) && fs.existsSync(globalPath))
			return;
	} catch {
		// guard failure must never block registration
	}

	let STORE: string;
	try {
		const here =
			(import.meta as any).dirname ?? path.dirname(fileURLToPath(import.meta.url));
		STORE = path.join(path.resolve(here, ".."), "current-prompt-contexts.json");
	} catch {
		STORE = path.join(
			os.homedir(),
			".pi",
			"agent",
			"current-prompt-contexts.json",
		);
	}

	let currentContext = "";
	let currentLabel = "";
	let requestId = 0;
	let timer: NodeJS.Timeout | null = null;
	let idleTimer: NodeJS.Timeout | null = null;
	let frameIdx = 0;
	// Last string written to the footer status, so spinner ticks that only
	// change the glyph don't force a repaint. See setStatusIfChanged.
	let lastStatus: string | null = null;
	let summaryAbort: AbortController | null = null;
	let activeSubagents = 0;
	let activeJobs = 0;
	let lastSubagentScanAt = 0;
	let idleZeroStreak = 0;
	let idleWatchTimer: NodeJS.Timeout | null = null;
	const activeQuestionToolCalls = new Set<string>();

	// --- context capture & persistence ---------------------------------------

	function sessionKey(ctx: ExtensionContext): string {
		try {
			return (
				(ctx.sessionManager as any).getSessionId?.() ??
				(ctx.sessionManager as any).getSessionFile?.() ??
				"__ephemeral__"
			);
		} catch {
			return "__ephemeral__";
		}
	}

	function readStore(): Record<string, string> {
		try {
			const raw = fs.readFileSync(STORE, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object")
				return parsed as Record<string, string>;
		} catch {
			// missing/corrupt store just means re-asking
		}
		return {};
	}

	function loadContext(ctx: ExtensionContext) {
		try {
			currentContext = readStore()[sessionKey(ctx)] ?? "";
		} catch {
			currentContext = "";
		}
	}

	function persistContext(ctx: ExtensionContext) {
		try {
			const store = readStore();
			if (currentContext) store[sessionKey(ctx)] = currentContext;
			else delete store[sessionKey(ctx)];
			fs.mkdirSync(path.dirname(STORE), { recursive: true });
			fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
		} catch {
			// losing persistence just means re-asking
		}
	}

	function setContext(ctx: ExtensionContext, value: string) {
		currentContext = value;
		persistContext(ctx);
	}

	async function ensureContext(ctx: ExtensionContext): Promise<boolean> {
		if (currentContext) return true;
		if (!ctx.hasUI) return false; // never block print mode
		let answer: string | undefined;
		try {
			answer = await ctx.ui.input(
				"What are you working on? (sets the context shown alongside every prompt)",
				"e.g. benchmark scoring, fix login redirect, refactor db pool",
			);
		} catch {
			return false;
		}
		const trimmed = (answer ?? "").trim();
		if (!trimmed) return false;
		setContext(ctx, shorten(trimmed, CONTEXT_MAX_LEN));
		return true;
	}

	function currentSessionIds(ctx: ExtensionContext): string[] {
		const ids: string[] = [];
		try {
			// pi-subagents keys runs by the session FILE first
			const file = (ctx.sessionManager as any).getSessionFile?.();
			if (typeof file === "string" && file) ids.push(file);
			const id = (ctx.sessionManager as any).getSessionId?.();
			if (typeof id === "string" && id) ids.push(id);
		} catch {
			// ignore
		}
		return ids;
	}

	// --- rendering ------------------------------------------------------------

	function core(ctx: ExtensionContext, themed: boolean): string {
		const theme = (ctx.ui as any).theme;
		const label =
			currentLabel || (themed ? theme.fg("dim", "idle") : "(no prompt yet)");
		if (!currentContext) return label;
		if (!themed) return `${currentContext}${SEP}${label}`;
		return theme.fg("accent", currentContext) + theme.fg("dim", SEP) + label;
	}

	function backgroundLabel(): string {
		const parts: string[] = [];
		if (activeSubagents > 0)
			parts.push(
				`${activeSubagents} subagent${activeSubagents === 1 ? "" : "s"} running`,
			);
		if (activeJobs > 0)
			parts.push(`${activeJobs} job${activeJobs === 1 ? "" : "s"} running`);
		return parts.join(" · ") || "working";
	}

	function backgroundCore(ctx: ExtensionContext, themed: boolean): string {
		const theme = (ctx.ui as any).theme;
		const label = backgroundLabel();
		if (!themed)
			return currentContext ? `${currentContext}${SEP}${label}` : label;
		const styledLabel = theme.fg("warning", label);
		if (!currentContext) return styledLabel;
		return (
			theme.fg("accent", currentContext) + theme.fg("dim", SEP) + styledLabel
		);
	}

	// The footer status channel calls ui.requestRender() with no diffing, so a
	// spinner tick that only changed one glyph used to cost a full TUI frame
	// (~12.5/sec while busy). Only write when the rendered line actually changes.
	function setStatusIfChanged(ctx: ExtensionContext, text: string) {
		if (lastStatus === text) return;
		lastStatus = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function paint(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		try {
			// Title stays short on purpose: terminals already decorate tabs with
			// the cwd / process name themselves, so we omit the `— cwd` suffix
			// (the footer keeps the full line). Keeps ✓/?/spinner visible with many tabs.
			const frame = SPINNER[frameIdx++ % SPINNER.length];
			const theme = (ctx.ui as any).theme;
			ctx.ui.setTitle(`${frame} ${core(ctx, false)}`);
			setStatusIfChanged(
				ctx,
				`${theme.fg("accent", STATIC_MARK)} ${core(ctx, true)}`,
			);
		} catch {
			// rendering must never break the turn
		}
	}

	function showCheck(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		try {
			const theme = (ctx.ui as any).theme;
			ctx.ui.setTitle(`✓ ${core(ctx, false)}`);
			setStatusIfChanged(
				ctx,
				`${theme.fg("success", "✓")} ${core(ctx, true)}`,
			);
		} catch {
			// ignore
		}
	}

	function showQuestion(ctx: ExtensionContext) {
		stopBackground();
		stopSpinner();
		if (!ctx.hasUI) return;
		try {
			const theme = (ctx.ui as any).theme;
			ctx.ui.setTitle(`? ${core(ctx, false)}`);
			setStatusIfChanged(
				ctx,
				`${theme.fg("warning", "?")} ${core(ctx, true)}`,
			);
		} catch {
			// ignore
		}
	}

	function stopSpinner() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function stopIdlePoll() {
		if (idleTimer) {
			clearInterval(idleTimer);
			idleTimer = null;
		}
	}

	function stopSlowWatch() {
		if (idleWatchTimer) {
			clearInterval(idleWatchTimer);
			idleWatchTimer = null;
		}
	}

	function stopBackground() {
		stopIdlePoll();
		stopSlowWatch();
	}

	function startSpinner(ctx: ExtensionContext) {
		if (activeQuestionToolCalls.size > 0) {
			showQuestion(ctx);
			return;
		}
		if (!ctx.hasUI) return;
		stopBackground();
		stopSpinner();
		paint(ctx);
		timer = setInterval(() => paint(ctx), 80);
		(timer as any)?.unref?.();
	}

	function paintBackgroundIdle(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		try {
			const now = Date.now();
			if (now - lastSubagentScanAt >= SUBAGENT_SCAN_MS) {
				lastSubagentScanAt = now;
				const found = scanBackground(currentSessionIds(ctx));
				if (found && found.subagents + found.jobs > 0) {
					// Fresh evidence of work: reset the streak, repaint at once.
					idleZeroStreak = 0;
					activeSubagents = found.subagents;
					activeJobs = found.jobs;
				} else if (found) {
					// A lone zero scan proves nothing (mid-spawn status.json
					// gap, torn dir listing) — settle only after consecutive zeros.
					idleZeroStreak++;
					if (idleZeroStreak >= IDLE_ZERO_CONFIRM) {
						activeSubagents = 0;
						activeJobs = 0;
						stopIdlePoll();
						showCheck(ctx);
						startSlowWatch(ctx);
						return;
					}
					// Otherwise keep the previous label + spinner this tick.
				}
				// found === null: the scan told us nothing — hold the last frame.
			}
			const frame = SPINNER[frameIdx++ % SPINNER.length];
			const theme = (ctx.ui as any).theme;
			ctx.ui.setTitle(`${frame} ${backgroundCore(ctx, false)}`);
			setStatusIfChanged(
				ctx,
				`${theme.fg("warning", STATIC_MARK)} ${backgroundCore(ctx, true)}`,
			);
		} catch {
			// ignore
		}
	}

	function startSlowWatch(ctx: ExtensionContext) {
		// Last line of defence against the stuck ✓: while the footer claims
		// idle, re-scan cheaply. Work that spawns after the ✓ is already shown
		// re-arms the spinner within IDLE_WATCH_MS instead of wedging the ✓.
		if (!ctx.hasUI || idleWatchTimer) return;
		stopIdlePoll();
		idleWatchTimer = setInterval(() => {
			try {
				if (timer || idleTimer || activeQuestionToolCalls.size > 0) return;
				const found = scanBackground(currentSessionIds(ctx));
				if (found && found.subagents + found.jobs > 0) enterIdle(ctx);
			} catch {
				// a watch glitch must never touch the footer
			}
		}, IDLE_WATCH_MS);
		(idleWatchTimer as any)?.unref?.();
	}

	function startIdlePoll(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		stopSlowWatch();
		stopIdlePoll();
		paintBackgroundIdle(ctx);
		idleTimer = setInterval(() => paintBackgroundIdle(ctx), SUBAGENT_FRAME_MS);
		(idleTimer as any)?.unref?.();
	}

	function enterIdle(ctx: ExtensionContext) {
		stopSpinner();
		stopSlowWatch();
		if (!ctx.hasUI) return;
		if (activeQuestionToolCalls.size > 0) {
			showQuestion(ctx);
			return;
		}
		const found = scanBackground(currentSessionIds(ctx));
		lastSubagentScanAt = Date.now();
		idleZeroStreak = 0;
		if (found && found.subagents + found.jobs > 0) {
			activeSubagents = found.subagents;
			activeJobs = found.jobs;
			startIdlePoll(ctx);
		} else {
			// found === null (unreadable scan) also lands here: show the ✓
			// but keep the slow watch running so real work re-arms the spinner.
			activeSubagents = 0;
			activeJobs = 0;
			stopIdlePoll();
			showCheck(ctx);
			startSlowWatch(ctx);
		}
	}

	function refresh(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (activeQuestionToolCalls.size > 0) {
			showQuestion(ctx);
			return;
		}
		if (!timer) enterIdle(ctx); // repaint when idle
	}

	async function summarizeInBackground(
		ctx: ExtensionContext,
		prompt: string,
		id: number,
	) {
		try {
			const model = (ctx as any).model;
			if (!model) return; // keep the truncated prompt
			const auth = await (ctx as any).modelRegistry?.getApiKeyAndHeaders?.(model);
			if (!auth?.ok || !auth.apiKey) return;
			summaryAbort?.abort();
			const controller = new AbortController();
			summaryAbort = controller;
			const response = (await complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: SUMMARY_INSTRUCTION + prompt }],
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					reasoningEffort: "low",
					signal: controller.signal,
				},
			)) as any;
			const parts = Array.isArray(response?.content) ? response.content : [];
			const summary = parts
				.filter((p: any) => p?.type === "text" && typeof p.text === "string")
				.map((p: any) => p.text)
				.join(" ")
				.trim();
			if (summary && id === requestId) {
				currentLabel = shorten(summary, MAX_LEN);
				if (!timer && !idleTimer && ctx.hasUI)
					showCheck(ctx); // repaint the ✓ line
				else if (ctx.hasUI) paint(ctx);
			}
		} catch {
			// abort or model error keeps the truncated prompt already on screen
		}
	}

	// --- event wiring ----------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		if (!ctx.hasUI) return { action: "continue" } as const;
		if ((event as any).source === "extension")
			return { action: "continue" } as const;
		if (currentContext) return { action: "continue" } as const;
		if (!((event as any).text ?? "").trim())
			return { action: "continue" } as const;
		if (await ensureContext(ctx)) return { action: "continue" } as const;
		try {
			ctx.ui.setEditorText((event as any).text);
		} catch {
			// ignore
		}
		if (ctx.hasUI) {
			try {
				ctx.ui.notify(
					"A working context is required before running a prompt. Add one (or use /context), then resubmit.",
					"warning",
				);
			} catch {
				// ignore
			}
		}
		return { action: "handled" } as const;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const prompt =
			typeof (event as any).prompt === "string"
				? (event as any).prompt.trim()
				: "";
		if (prompt) {
			requestId++;
			currentLabel = shorten(prompt, MAX_LEN); // instant fallback
			startSpinner(ctx);
			if (prompt.length > SUMMARIZE_MIN_LEN)
				void summarizeInBackground(ctx, prompt, requestId);
		} else {
			startSpinner(ctx); // e.g. continuation
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		startSpinner(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if ((event as any).toolName === "ask_user_question") {
			activeQuestionToolCalls.add((event as any).toolCallId);
			if (ctx.hasUI) showQuestion(ctx);
		}
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (
			activeQuestionToolCalls.delete((event as any).toolCallId) &&
			activeQuestionToolCalls.size === 0
		) {
			startSpinner(ctx); // back to work
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		enterIdle(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		loadContext(ctx);
		enterIdle(ctx);
	});

	pi.on("session_shutdown", async () => {
		summaryAbort?.abort();
		summaryAbort = null;
		activeQuestionToolCalls.clear();
		stopSpinner();
		stopBackground();
		lastStatus = null; // force the next footer write through
	});

	pi.registerCommand("context", {
		description: "Set/show/clear the working context shown alongside the prompt",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (/^(clear|reset|none)$/i.test(arg)) {
				setContext(ctx, "");
				if (ctx.hasUI)
					ctx.ui.notify(
						"Context cleared — you'll be asked on the next prompt.",
						"info",
					);
				refresh(ctx);
				return;
			}
			if (arg) {
				setContext(ctx, shorten(arg, CONTEXT_MAX_LEN));
				if (ctx.hasUI) ctx.ui.notify(`Context: ${currentContext}`, "info");
				refresh(ctx);
				return;
			}
			if (ctx.hasUI) {
				let answer: string | undefined;
				try {
					answer = await ctx.ui.input(
						"Working context:",
						currentContext || "What are you working on?",
					);
				} catch {
					return;
				}
				if (answer !== undefined) {
					if (answer.trim()) {
						setContext(ctx, shorten(answer.trim(), CONTEXT_MAX_LEN));
						ctx.ui.notify(`Context: ${currentContext}`, "info");
					} else {
						setContext(ctx, "");
						ctx.ui.notify(
							"Context cleared — you'll be asked on the next prompt.",
							"info",
						);
					}
					refresh(ctx);
				}
			} else if (currentContext) {
				ctx.ui.notify(`Context: ${currentContext}`, "info");
			}
		},
	});
}
