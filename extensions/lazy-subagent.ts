// lazy-subagent.ts — keep subagent tools out of the active set until needed.
//
// The pi-subagents package registers subagent/subagent_wait/subagent_supervisor
// globally. subagent's schema is the single largest tool definition in the whole
// prompt (chain/parallel/async/management/control in one nested schema). Most
// turns never delegate at all — always paying that schema cost is waste.
//
// This ports the proven lazy-tool pattern from jobs.ts, with one difference:
// job_run is a tool we own, so it can trigger its own activation. subagent* is
// owned by the pi-subagents package — there is no tool of ours to hang the
// trigger on, hence the dedicated always-active activator tool enable_delegation.
// The PM calls it once, deliberately, right before its first real delegation,
// and delegation stays active for the rest of the session.
//
// Resumed-session edge case: a resumed session with an already-running
// background subagent run still starts with these inactive — call
// enable_delegation first, then subagent_wait. No state is lost, just tool access.
//
// Scoped to its install location (project-local → only that project; global →
// every project). Reversible: delete this file (or empty LAZY_SUBAGENT_TOOLS)
// and /reload restores stock always-on behavior.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const LAZY_SUBAGENT_TOOLS = [
	"subagent",
	"subagent_wait",
	"subagent_supervisor",
];

function activateDelegationTools(pi: ExtensionAPI): string[] {
	const all = pi.getAllTools().map((t) => t.name);
	const active = pi.getActiveTools();
	const missing = LAZY_SUBAGENT_TOOLS.filter(
		(name) => all.includes(name) && !active.includes(name),
	);
	if (missing.length > 0)
		pi.setActiveTools([...new Set([...active, ...missing])]);
	return missing;
}

export default function (pi: ExtensionAPI) {
	let delegationEnabled = false;

	function deactivate() {
		if (delegationEnabled) return;
		const active = pi.getActiveTools();
		const filtered = active.filter((name) => !LAZY_SUBAGENT_TOOLS.includes(name));
		if (filtered.length !== active.length)
			pi.setActiveTools([...new Set(filtered)]);
	}

	pi.registerTool({
		name: "enable_delegation",
		label: "Enable Delegation",
		description:
			"Activate subagent/subagent_wait/subagent_supervisor for the rest of this session. Call this ONCE, right before your first delegation, if those tools are not already available. No-op if already enabled.",
		promptSnippet:
			"Call enable_delegation before your first subagent/subagent_wait use if delegation tools aren't already active.",
		promptGuidelines: [
			"subagent/subagent_wait/subagent_supervisor start INACTIVE each session to save tool-schema cost. Call enable_delegation once, right before you actually need to delegate, to activate them. It is a no-op if already enabled.",
		],
		parameters: Type.Object({}),
		async execute() {
			delegationEnabled = true;
			const activated = activateDelegationTools(pi);
			const text =
				activated.length > 0
					? `Delegation tools activated: ${activated.join(", ")}.`
					: "Delegation tools were already active.";
			return { content: [{ type: "text", text }], details: { activated } };
		},
	});

	// session_start covers the common case cheaply. before_agent_start is the
	// backstop: pi-subagents registers subagent_supervisor/intercom inside ITS
	// OWN session_start handler, not at load time, so depending on
	// cross-extension ordering the tools may not exist yet when our
	// session_start runs. before_agent_start fires after every extension's
	// session_start work, so reapplying there (guarded by delegationEnabled)
	// is guaranteed-correct without undoing an already-active enable_delegation.
	pi.on("session_start", async () => {
		deactivate();
	});
	pi.on("before_agent_start", async () => {
		deactivate();
	});
}
