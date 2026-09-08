/**
 * my-todo — a personal todo list for YOU (the human), not the agent.
 *
 * Scopes: "global" plus any number of named projects, all stored as plain
 * human-editable JSON files:
 *   - global  ~/projects/pi-extensions-lhg-private/todos.json   (day-to-day + life)
 *     (falls back to ~/.pi/agent/my-todo/todos.json when the private repo is absent)
 *   - <name>  <same-dir>/projects.json  →  { "<name>": { nextId, items[] }, … }
 *
 * The legacy scope "project" means "the project named after the current
 * directory" (backwards compatible with the old per-cwd file, which is
 * imported once on first use).
 *
 * - `/myday` opens an interactive TUI panel (navigate, add, edit,
 *   toggle, delete, switch scope with Tab, add project with p).
 * - `/mytodo` quick CLI: add / done / rm / list / projects, with -p <name>
 *   (bare -p = current-directory project) for a named project scope.
 * - `my_todo` agent tool: list/add/toggle/delete in any scope, plus
 *   projects (list them) and delete-project. Nothing is auto-injected.
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

/** A scope as the user sees it: "global" or a project name. */
type ScopeName = string;

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
const PROJECTS_FILE = "projects.json";

type NamedProjects = Record<string, MyTodoStore>;

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

function projectsPath(cwd: string): string {
	const g = storePath("global", cwd);
	return join(dirname(g), PROJECTS_FILE);
}

function sanitizeStore(raw: unknown): MyTodoStore | null {
	try {
		const r = raw as Partial<MyTodoStore>;
		if (!r || !Array.isArray(r.items)) return null;
		return {
			nextId: typeof r.nextId === "number" ? r.nextId : r.items.length + 1,
			items: r.items.filter(
				(i) => typeof i?.id === "number" && typeof i?.text === "string",
			),
		};
	} catch {
		return null;
	}
}

function loadProjects(cwd: string): NamedProjects {
	try {
		const p = projectsPath(cwd);
		if (!existsSync(p)) return {};
		// SAFETY: file is written only by saveProjects; validate shape below.
		const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
		const out: NamedProjects = {};
		if (raw && typeof raw === "object") {
			for (const [k, v] of Object.entries(raw)) {
				if (typeof k !== "string" || !k || k === "global") continue;
				const s = sanitizeStore(v);
				if (s) out[k] = s;
			}
		}
		return out;
	} catch {
		return {};
	}
}

function saveProjects(cwd: string, projects: NamedProjects): void {
	const p = projectsPath(cwd);
	mkdirSync(dirname(p), { recursive: true });
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
	renameSync(tmp, p);
}

/** Resolve a user-facing scope name to its store. "project" = cwd-named project. */
function resolveScope(
	scope: ScopeName,
	cwd: string,
): { tag: string; load: () => MyTodoStore; save: (s: MyTodoStore) => void } {
	if (scope === "global") {
		return {
			tag: "global",
			load: () => loadStore("global", cwd),
			save: (s) => saveStore("global", cwd, s),
		};
	}
	const name = scope === "project" ? basename(cwd) : scope.trim();
	if (!name) throw new Error("project name must not be empty");
	return {
		tag: name,
		load: () => {
			const all = loadProjects(cwd);
			const hit = all[name];
			if (hit) return hit;
			// One-time migration: old per-cwd project file (<cwd>/.pi/my-todo/todos.json).
			// Only for the project named after this directory — never seed other names.
			if (name === basename(cwd)) {
				const legacy = readStoreFile(join(cwd, CONFIG_DIR_NAME, "my-todo", "todos.json"));
				if (legacy && legacy.items.length > 0) {
					all[name] = legacy;
					try {
						saveProjects(cwd, all);
					} catch {
						// ignore migration write failures; still return legacy content
					}
					return legacy;
				}
			}
			return emptyStore();
		},
		save: (s) => {
			const all = loadProjects(cwd);
			all[name] = s;
			saveProjects(cwd, all);
		},
	};
}

function listProjectNames(cwd: string): Array<{ name: string; open: number; total: number }> {
	const all = loadProjects(cwd);
	return Object.entries(all)
		.map(([name, s]) => ({
			name,
			open: s.items.filter((t) => !t.done).length,
			total: s.items.length,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
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
	private stores = new Map<string, MyTodoStore>();
	private scopes: string[] = ["global"];
	private scopeIdx = 0;
	private cwd: string;
	private theme: Theme;
	private onClose: () => void;
	private cursor = 0;
	private mode: "nav" | "input" = "nav";
	private inputKind: "add" | "edit" | "project" = "add";
	private buffer = "";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(cwd: string, theme: Theme, onClose: () => void) {
		this.cwd = cwd;
		this.theme = theme;
		this.onClose = onClose;
		this.refreshScopes();
	}

	private scope(): string {
		return this.scopes[this.scopeIdx] ?? "global";
	}

	private refreshScopes(): void {
		const names = listProjectNames(this.cwd).map((p) => p.name);
		const cwdName = basename(this.cwd);
		this.scopes = ["global", ...names];
		if (!names.includes(cwdName)) this.scopes.push(cwdName);
		const cur = this.scope();
		const at = this.scopes.indexOf(cur);
		this.scopeIdx = at >= 0 ? at : 0;
	}

	private store(): MyTodoStore {
		const name = this.scope();
		let s = this.stores.get(name);
		if (!s) {
			s = resolveScope(name, this.cwd).load();
			this.stores.set(name, s);
		}
		return s;
	}

	private items(): MyTodoItem[] {
		return this.store().items;
	}

	private persist(): void {
		resolveScope(this.scope(), this.cwd).save(this.store());
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
					} else if (this.inputKind === "project") {
						// Create the project (empty store) and switch to it.
						const all = loadProjects(this.cwd);
						if (!all[text]) {
							all[text] = emptyStore();
							saveProjects(this.cwd, all);
						}
						this.refreshScopes();
						this.scopeIdx = this.scopes.indexOf(text);
						this.cursor = 0;
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
			this.scopeIdx = (this.scopeIdx + 1) % this.scopes.length;
			this.cursor = 0;
			this.invalidate();
			return;
		}
		if (data >= "1" && data <= "9") {
			const at = Number(data) - 1;
			if (at < this.scopes.length) {
				this.scopeIdx = at;
				this.cursor = 0;
				this.invalidate();
			}
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
		if (data === "p" || data === "P") {
			this.mode = "input";
			this.inputKind = "project";
			this.buffer = "";
			this.invalidate();
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
		const tabs = this.scopes
			.slice(0, 9)
			.map((name, i) => {
				const s = this.stores.get(name) ?? resolveScope(name, this.cwd).load();
				this.stores.set(name, s);
				const open = s.items.filter((t) => !t.done).length;
				const label = name === "global" ? "Global" : name;
				return i === this.scopeIdx
					? th.fg("accent", th.bold(`[${i + 1} ${label} ●]`))
					: th.fg("dim", `[${i + 1} ${label} (${open})`);
			})
			.join("  ");
		const title = ` My day  ${tabs} `;
		lines.push(
			truncateToWidth(
				th.fg("borderMuted", "─".repeat(3)) +
					title +
					th.fg("borderMuted", "─".repeat(Math.max(0, width - 15))),
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
			const prompt =
				this.inputKind === "project" ? "New project" : this.inputKind === "add" ? "Add" : "Edit";
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
					`  ${th.fg("dim", "a add · e edit · space done · d delete · p project · tab switch · q close")}`,
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
	scope: Type.Optional(Type.String({
		description: 'Scope: "global" or a project name ("project" = current-directory project)',
	})),
	action: StringEnum(["list", "add", "toggle", "delete", "projects", "delete-project"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add), or project name (for delete-project)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle/delete)" })),
});

function resolveCwd(ctx: ExtensionContext): string {
	// SAFETY: TUI/command contexts carry cwd at runtime; optional access is safe when absent.
	const maybe = (ctx as { cwd?: string }).cwd;
	return maybe || process.cwd();
}

export default function (pi: ExtensionAPI) {
	// Agent-callable tool (list/add/toggle/delete in any scope, plus project admin)
	pi.registerTool({
		name: "my_todo",
		label: "MyTodo",
		description:
			"Manage the HUMAN's personal todo list (tickets, env fixes, follow-ups). " +
			"Scopes: global (day-to-day/life) or a named project (adding to a new name creates it; " +
			"\"project\" means the current-directory project). " +
			"Actions: list, add (text), toggle (id), delete (id), projects (list them), " +
			"delete-project (text = project name).",
		parameters: MyTodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// SAFETY: tool runtime passes an ExtensionContext; resolveCwd tolerates a missing cwd.
			const cwd = resolveCwd(ctx as unknown as ExtensionContext);

			if (params.action === "projects") {
				const names = listProjectNames(cwd);
				const text =
					names.length === 0
						? "No projects yet — add a todo with a new scope name to create one."
						: names.map((p) => `- ${p.name} (${p.open} open / ${p.total} total)`).join("\n");
				return {
					content: [{ type: "text", text }],
					details: { projects: names },
				};
			}

			if (params.action === "delete-project") {
				const name = (params.text ?? "").trim();
				if (!name || name === "global") {
					return {
						content: [{ type: "text", text: "Error: text must name a project to delete" }],
						details: {},
					};
				}
				const all = loadProjects(cwd);
				const key = name === "project" ? basename(cwd) : name;
				if (!all[key]) {
					return {
						content: [{ type: "text", text: `Project "${key}" not found` }],
						details: {},
					};
				}
				delete all[key];
				saveProjects(cwd, all);
				return {
					content: [{ type: "text", text: `Deleted project "${key}"` }],
					details: {},
				};
			}

			const resolved = resolveScope(params.scope ?? "global", cwd);
			const store = resolved.load();
			const tag = resolved.tag;

			switch (params.action) {
				case "list":
					return {
						content: [{ type: "text", text: `[${tag}]\n${formatList(store.items)}` }],
						details: { scope: tag, todos: store.items },
					};
				case "add": {
					if (!params.text?.trim()) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: {},
						};
					}
					const item = addItem(store, params.text.trim());
					resolved.save(store);
					return {
						content: [
							{ type: "text", text: `Added [${tag}] #${item.id}: ${item.text}` },
						],
						details: { scope: tag, todos: store.items },
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
					resolved.save(store);
					return {
						content: [
							{
								type: "text",
								text: `[${tag}] #${item.id} ${item.done ? "done" : "reopened"}`,
							},
						],
						details: { scope: tag, todos: store.items },
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
					resolved.save(store);
					return {
						content: [{ type: "text", text: `Deleted [${tag}] #${params.id}` }],
						details: { scope: tag, todos: store.items },
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

	// /mytodo — quick CLI: add/done/rm/list/projects [-p [<name>]]
	pi.registerCommand("mytodo", {
		description:
			"Quick personal todos: add <text> | done <id> | rm <id> | list | projects | rmproject <name> (-p [<name>] = project scope)",
		handler: async (args, ctx) => {
			const cwd = resolveCwd(ctx);
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			// -p, -p=name, -p name, --project[=name]; bare -p = current-directory project.
			let scopeName = "global";
			const rest: string[] = [];
			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i];
				if (t === "-p" || t === "--project") {
					const next = tokens[i + 1];
					if (next && !"add done toggle rm delete list projects rmproject".split(" ").includes(next)) {
						scopeName = next;
						i++;
					} else {
						scopeName = "project";
					}
				} else if (t.startsWith("-p=")) {
					scopeName = t.slice(3) || "project";
				} else if (t.startsWith("--project=")) {
					scopeName = t.slice(10) || "project";
				} else {
					rest.push(t);
				}
			}
			const [sub, ...tail] = rest;
			const usage = "/mytodo add <text> | done <id> | rm <id> | list | projects | rmproject <name> (-p [<name>])";

			if (sub === "projects") {
				const names = listProjectNames(cwd);
				ctx.ui.notify(
					names.length === 0
						? "No projects yet."
						: names.map((p) => `- ${p.name} (${p.open} open / ${p.total} total)`).join("\n"),
					"info",
				);
				return;
			}

			if (sub === "rmproject") {
				const name = (tail[0] ?? "").trim();
				if (!name || name === "global") {
					ctx.ui.notify("Usage: /mytodo rmproject <name>", "error");
					return;
				}
				const all = loadProjects(cwd);
				if (!all[name]) {
					ctx.ui.notify(`Project "${name}" not found`, "error");
					return;
				}
				delete all[name];
				saveProjects(cwd, all);
				ctx.ui.notify(`Deleted project "${name}"`, "info");
				return;
			}

			const resolved = resolveScope(scopeName, cwd);
			const tag = resolved.tag;

			if (!sub || sub === "list") {
				if (ctx.mode === "tui") {
					await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
						return new MyDayPanel(cwd, theme, () => done());
					});
					return;
				}
				const store = resolved.load();
				ctx.ui.notify(`[${tag}]\n${formatList(store.items)}`, "info");
				return;
			}

			if (sub === "add") {
				const text = tail.join(" ").trim();
				if (!text) {
					ctx.ui.notify("Usage: /mytodo add <text> [-p [<name>]]", "error");
					return;
				}
				const store = resolved.load();
				const item = addItem(store, text);
				resolved.save(store);
				ctx.ui.notify(`Added [${tag}] #${item.id}: ${item.text}`, "info");
				return;
			}

			if (sub === "done" || sub === "toggle") {
				const id = Number(tail[0]);
				if (!Number.isFinite(id)) {
					ctx.ui.notify("Usage: /mytodo done <id> [-p [<name>]]", "error");
					return;
				}
				const store = resolved.load();
				const item = store.items.find((t) => t.id === id);
				if (!item) {
					ctx.ui.notify(`Todo #${id} not found in [${tag}]`, "error");
					return;
				}
				item.done = !item.done;
				item.doneAt = item.done ? new Date().toISOString() : undefined;
				resolved.save(store);
				ctx.ui.notify(
					`[${tag}] #${item.id} ${item.done ? "done ✓" : "reopened"}`,
					"info",
				);
				return;
			}

			if (sub === "rm" || sub === "delete") {
				const id = Number(tail[0]);
				if (!Number.isFinite(id)) {
					ctx.ui.notify("Usage: /mytodo rm <id> [-p [<name>]]", "error");
					return;
				}
				const store = resolved.load();
				const before = store.items.length;
				store.items = store.items.filter((t) => t.id !== id);
				if (store.items.length === before) {
					ctx.ui.notify(`Todo #${id} not found in [${tag}]`, "error");
					return;
				}
				resolved.save(store);
				ctx.ui.notify(`Deleted [${tag}] #${id}`, "info");
				return;
			}

			ctx.ui.notify(`Usage: ${usage}`, "error");
		},
	});
}
