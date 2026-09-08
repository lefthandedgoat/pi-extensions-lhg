/**
 * my-todo — a personal todo list for YOU (the human), not the agent.
 *
 * Two scopes, both stored as plain human-editable JSON files:
 *   - global  ~/projects/pi-extensions-lhg-private/todos.json   (day-to-day + life)
 *     (falls back to ~/.pi/agent/my-todo/todos.json when the private repo is absent)
 *   - project <cwd>/.pi/my-todo/todos.json     (per-project: db, api, …)
 *
 * - `/myday` opens an interactive TUI panel (navigate, add, edit,
 *   toggle, delete, switch scope with Tab).
 * - `/mytodo` quick CLI: add / done / rm / list, with -p for project scope.
 * - `my_todo` agent tool: the agent can list/add/toggle/delete in either
 *   scope when you ask it to. Nothing is auto-injected into prompts.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { Type } from "typebox";

type Scope = "global" | "project";

interface MyTodoItem {
	id: number;
	text: string;
	done: boolean;
	createdAt: string;
	doneAt?: string;
}

interface MyTodoStore {
	nextId: number;
	items: MyTodoItem[];
}

const emptyStore = (): MyTodoStore => ({ nextId: 1, items: [] });

// ---------------------------------------------------------------------------
// File storage (lazy node:fs so the module stays light until used)
//
// Global scope lives in the private data repo so todo contents stay out of
// the public repo and get git backup. Falls back to the legacy ~/.pi path
// when the private repo isn't present (e.g. a fresh machine).
// ---------------------------------------------------------------------------

const PRIVATE_REPO_DIR = "pi-extensions-lhg-private";
const PRIVATE_TODOS_FILE = "todos.json";

function privateGlobalPath(): string | null {
	const dir = join(homedir(), "projects", PRIVATE_REPO_DIR);
	if (!existsSync(dir)) return null;
	return join(dir, PRIVATE_TODOS_FILE);
}

function legacyGlobalPath(): string {
	return join(homedir(), ".pi", "agent", "my-todo", "todos.json");
}

function storePath(scope: Scope, cwd: string): string {
	if (scope === "global") return privateGlobalPath() ?? legacyGlobalPath();
	return join(cwd, CONFIG_DIR_NAME, "my-todo", "todos.json");
}

function readStoreFile(p: string): MyTodoStore | null {
	try {
		if (!existsSync(p)) return null;
		// SAFETY: JSON file is written only by saveStore; validate shape before trusting it.
		const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<MyTodoStore>;
		if (!Array.isArray(raw.items)) return null;
		return {
			nextId: typeof raw.nextId === "number" ? raw.nextId : raw.items.length + 1,
			items: raw.items.filter(
				(i) => typeof i?.id === "number" && typeof i?.text === "string",
			),
		};
	} catch {
		return null;
	}
}

function loadStore(scope: Scope, cwd: string): MyTodoStore {
	const p = storePath(scope, cwd);
	const primary = readStoreFile(p);
	if (primary) return primary;
	// One-time migration: private repo selected but empty, legacy file has data.
	if (scope === "global" && p !== legacyGlobalPath()) {
		const legacy = readStoreFile(legacyGlobalPath());
		if (legacy) {
			try {
				saveStore(scope, cwd, legacy);
			} catch {
				// ignore migration write failures; fall through to legacy content
			}
			return legacy;
		}
	}
	return emptyStore();
}

function saveStore(scope: Scope, cwd: string, store: MyTodoStore): void {
	const p = storePath(scope, cwd);
	mkdirSync(dirname(p), { recursive: true });
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
	renameSync(tmp, p);
}

function addItem(store: MyTodoStore, text: string): MyTodoItem {
	const item: MyTodoItem = {
		id: store.nextId++,
		text,
		done: false,
		createdAt: new Date().toISOString(),
	};
	store.items.push(item);
	return item;
}

function formatList(items: MyTodoItem[]): string {
	if (items.length === 0) return "No todos";
	return items
		.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`)
		.join("\n");
}

// ---------------------------------------------------------------------------
// Interactive TUI panel
// ---------------------------------------------------------------------------

class MyDayPanel {
	private global: MyTodoStore;
	private project: MyTodoStore;
	private projectName: string;
	private cwd: string;
	private theme: Theme;
	private onClose: () => void;
	private scope: Scope = "global";
	private cursor = 0;
	private mode: "nav" | "input" = "nav";
	private inputKind: "add" | "edit" = "add";
	private buffer = "";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(cwd: string, theme: Theme, onClose: () => void) {
		this.cwd = cwd;
		this.projectName = basename(cwd);
		this.theme = theme;
		this.onClose = onClose;
		this.global = loadStore("global", cwd);
		this.project = loadStore("project", cwd);
	}

	private store(): MyTodoStore {
		return this.scope === "global" ? this.global : this.project;
	}

	private items(): MyTodoItem[] {
		return this.store().items;
	}

	private persist(): void {
		saveStore(this.scope, this.cwd, this.store());
		this.invalidate();
	}

	private clampCursor(): void {
		const n = this.items().length;
		if (n === 0) this.cursor = 0;
		else this.cursor = Math.max(0, Math.min(this.cursor, n - 1));
	}

	handleInput(data: string): void {
		// --- input mode: free text entry ---
		if (this.mode === "input") {
			if (matchesKey(data, "escape")) {
				this.mode = "nav";
				this.buffer = "";
				this.invalidate();
				return;
			}
			if (matchesKey(data, "return") || data === "\r" || data === "\n") {
				const text = this.buffer.trim();
				if (text) {
					if (this.inputKind === "add") {
						addItem(this.store(), text);
					} else {
						const item = this.items()[this.cursor];
						if (item) item.text = text;
					}
					this.persist();
				}
				this.mode = "nav";
				this.buffer = "";
				this.invalidate();
				return;
			}
			if (data === "\x7f" || data === "\b") {
				this.buffer = this.buffer.slice(0, -1);
				this.invalidate();
				return;
			}
			if (data === "\x15") {
				// ctrl+u: clear line
				this.buffer = "";
				this.invalidate();
				return;
			}
			// printable characters only (arrows etc. arrive multi-char)
			if (data.length === 1 && data >= " " && data !== "\x7f") {
				this.buffer += data;
				this.invalidate();
			}
			return;
		}

		// --- nav mode ---
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.onClose();
			return;
		}
		if (matchesKey(data, "up") || data === "k" || data === "K") {
			this.cursor = Math.max(0, this.cursor - 1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, "down") || data === "j" || data === "J") {
			this.cursor = Math.min(
				Math.max(0, this.items().length - 1),
				this.cursor + 1,
			);
			this.invalidate();
			return;
		}
		if (
			matchesKey(data, "tab") ||
			data === "\t" ||
			data === "s" ||
			data === "S"
		) {
			this.scope = this.scope === "global" ? "project" : "global";
			this.cursor = 0;
			this.invalidate();
			return;
		}
		if (data === "1") {
			this.scope = "global";
			this.cursor = 0;
			this.invalidate();
			return;
		}
		if (data === "2") {
			this.scope = "project";
			this.cursor = 0;
			this.invalidate();
			return;
		}
		if (
			data === " " ||
			data === "x" ||
			data === "X" ||
			matchesKey(data, "return")
		) {
			const item = this.items()[this.cursor];
			if (item) {
				item.done = !item.done;
				item.doneAt = item.done ? new Date().toISOString() : undefined;
				this.persist();
			}
			return;
		}
		if (data === "a" || data === "A") {
			this.mode = "input";
			this.inputKind = "add";
			this.buffer = "";
			this.invalidate();
			return;
		}
		if (data === "e" || data === "E") {
			const item = this.items()[this.cursor];
			if (item) {
				this.mode = "input";
				this.inputKind = "edit";
				this.buffer = item.text;
				this.invalidate();
			}
			return;
		}
		if (data === "d" || data === "D") {
			const items = this.items();
			const item = items[this.cursor];
			if (item) {
				this.store().items = items.filter((t) => t.id !== item.id);
				this.clampCursor();
				this.persist();
			}
			return;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];
		lines.push("");
		const gCount = this.global.items.filter((t) => !t.done).length;
		const pCount = this.project.items.filter((t) => !t.done).length;
		const gLabel =
			this.scope === "global"
				? th.fg("accent", th.bold("[1 Global ●]"))
				: th.fg("dim", `[1 Global (${gCount})`);
		const pLabel =
			this.scope === "project"
				? th.fg("accent", th.bold(`[2 ${this.projectName} ●]`))
				: th.fg("dim", `[2 ${this.projectName} (${pCount})`);
		const title = ` My day  ${gLabel}  ${pLabel} `;
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) +
					title +
					th.fg(
						"borderMuted",
						"─".repeat(Math.max(0, width - 12 - this.projectName.length)),
					),
				width,
			),
		);
		lines.push("");

		const items = this.items();
		if (items.length === 0) {
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", "Nothing here. Press a to add one.")}`,
					width,
				),
			);
		} else {
			const done = items.filter((t) => t.done).length;
			lines.push(
				truncateToWidth(
					`  ${th.fg("muted", `${done}/${items.length} done`)}`,
					width,
				),
			);
			lines.push("");
			items.forEach((t, i) => {
				const cursor = i === this.cursor ? th.fg("accent", "› ") : "  ";
				const check = t.done ? th.fg("success", "✓") : th.fg("dim", "○");
				const id = th.fg("accent", `#${t.id}`);
				const text = t.done ? th.fg("dim", t.text) : th.fg("text", t.text);
				lines.push(truncateToWidth(`${cursor}${check} ${id} ${text}`, width));
			});
		}

		lines.push("");
		if (this.mode === "input") {
			const prompt = this.inputKind === "add" ? "Add" : "Edit";
			lines.push(
				truncateToWidth(
					`  ${th.fg("accent", `${prompt}: `)}${this.buffer}${th.fg("accent", "█")}`,
					width,
				),
			);
			lines.push(
				truncateToWidth(`  ${th.fg("dim", "Enter save · Esc cancel")}`, width),
			);
		} else {
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", "a add · e edit · space done · d delete · tab switch scope · q close")}`,
					width,
				),
			);
		}
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const MyTodoParams = Type.Object({
	scope: Type.Optional(StringEnum(["global", "project"] as const)),
	action: StringEnum(["list", "add", "toggle", "delete"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle/delete)" })),
});

function resolveCwd(ctx: ExtensionContext): string {
	// SAFETY: TUI/command contexts carry cwd at runtime; optional access is safe when absent.
	const maybe = (ctx as { cwd?: string }).cwd;
	return maybe || process.cwd();
}

export default function (pi: ExtensionAPI) {
	// Agent-callable tool (list/add/toggle/delete, either scope)
	pi.registerTool({
		name: "my_todo",
		label: "MyTodo",
		description:
			"Manage the HUMAN's personal todo list (tickets, env fixes, follow-ups). " +
			"Scopes: global (day-to-day/life) or project (current repo). " +
			"Actions: list, add (text), toggle (id), delete (id).",
		parameters: MyTodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// SAFETY: tool runtime passes an ExtensionContext; resolveCwd tolerates a missing cwd.
			const cwd = resolveCwd(ctx as unknown as ExtensionContext);
			const scope: Scope = params.scope ?? "global";
			const store = loadStore(scope, cwd);
			const tag = scope === "global" ? "global" : "project";

			switch (params.action) {
				case "list":
					return {
						content: [{ type: "text", text: `[${tag}]\n${formatList(store.items)}` }],
						details: { scope, todos: store.items },
					};
				case "add": {
					if (!params.text?.trim()) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: {},
						};
					}
					const item = addItem(store, params.text.trim());
					saveStore(scope, cwd, store);
					return {
						content: [
							{ type: "text", text: `Added [${tag}] #${item.id}: ${item.text}` },
						],
						details: { scope, todos: store.items },
					};
				}
				case "toggle": {
					const item = store.items.find((t) => t.id === params.id);
					if (!item) {
						return {
							content: [
								{ type: "text", text: `Todo #${params.id} not found in [${tag}]` },
							],
							details: {},
						};
					}
					item.done = !item.done;
					item.doneAt = item.done ? new Date().toISOString() : undefined;
					saveStore(scope, cwd, store);
					return {
						content: [
							{
								type: "text",
								text: `[${tag}] #${item.id} ${item.done ? "done" : "reopened"}`,
							},
						],
						details: { scope, todos: store.items },
					};
				}
				case "delete": {
					const before = store.items.length;
					store.items = store.items.filter((t) => t.id !== params.id);
					if (store.items.length === before) {
						return {
							content: [
								{ type: "text", text: `Todo #${params.id} not found in [${tag}]` },
							],
							details: {},
						};
					}
					saveStore(scope, cwd, store);
					return {
						content: [{ type: "text", text: `Deleted [${tag}] #${params.id}` }],
						details: { scope, todos: store.items },
					};
				}
			}
		},
	});

	// /myday — interactive panel
	pi.registerCommand("myday", {
		description: "Open your personal todo panel (global + project)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/myday requires interactive mode", "error");
				return;
			}
			const cwd = resolveCwd(ctx);
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new MyDayPanel(cwd, theme, () => done());
			});
		},
	});

	// /mytodo — quick CLI: add/done/rm/list [-p]
	pi.registerCommand("mytodo", {
		description:
			"Quick personal todos: add <text> | done <id> | rm <id> | list (-p = project)",
		handler: async (args, ctx) => {
			const cwd = resolveCwd(ctx);
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const project = tokens.includes("-p") || tokens.includes("--project");
			const scope: Scope = project ? "project" : "global";
			const rest = tokens.filter((t) => t !== "-p" && t !== "--project");
			const [sub, ...tail] = rest;
			const tag = scope === "global" ? "global" : "project";

			if (!sub || sub === "list") {
				if (ctx.mode === "tui") {
					await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
						return new MyDayPanel(cwd, theme, () => done());
					});
					return;
				}
				const store = loadStore(scope, cwd);
				ctx.ui.notify(`[${tag}]\n${formatList(store.items)}`, "info");
				return;
			}

			if (sub === "add") {
				const text = tail.join(" ").trim();
				if (!text) {
					ctx.ui.notify("Usage: /mytodo add <text> [-p]", "error");
					return;
				}
				const store = loadStore(scope, cwd);
				const item = addItem(store, text);
				saveStore(scope, cwd, store);
				ctx.ui.notify(`Added [${tag}] #${item.id}: ${item.text}`, "info");
				return;
			}

			if (sub === "done" || sub === "toggle") {
				const id = Number(tail[0]);
				if (!Number.isFinite(id)) {
					ctx.ui.notify("Usage: /mytodo done <id> [-p]", "error");
					return;
				}
				const store = loadStore(scope, cwd);
				const item = store.items.find((t) => t.id === id);
				if (!item) {
					ctx.ui.notify(`Todo #${id} not found in [${tag}]`, "error");
					return;
				}
				item.done = !item.done;
				item.doneAt = item.done ? new Date().toISOString() : undefined;
				saveStore(scope, cwd, store);
				ctx.ui.notify(
					`[${tag}] #${item.id} ${item.done ? "done ✓" : "reopened"}`,
					"info",
				);
				return;
			}

			if (sub === "rm" || sub === "delete") {
				const id = Number(tail[0]);
				if (!Number.isFinite(id)) {
					ctx.ui.notify("Usage: /mytodo rm <id> [-p]", "error");
					return;
				}
				const store = loadStore(scope, cwd);
				const before = store.items.length;
				store.items = store.items.filter((t) => t.id !== id);
				if (store.items.length === before) {
					ctx.ui.notify(`Todo #${id} not found in [${tag}]`, "error");
					return;
				}
				saveStore(scope, cwd, store);
				ctx.ui.notify(`Deleted [${tag}] #${id}`, "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /mytodo add <text> | done <id> | rm <id> | list (-p = project)",
				"error",
			);
		},
	});
}
