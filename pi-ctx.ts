/**
 * pi-ctx — Context Language Models for Pi.
 *
 * Turns arXiv:2609.37725 (Context Language Models) into a Pi extension that
 * replaces the default /compact + auto-compact: the live conversation is
 * mirrored to a file, and the model edits that file to manage its own context.
 * When a turn ends and the file was edited, the file's content *becomes* the
 * live context (a retain-none compaction entry) — no summarizer LLM call.
 *
 * Mapping from the paper:
 *   mirror file              -> ~/.pi/agent/ctx/<sessionId>/context.md
 *   [[CTX_TURN n role=...]]  -> per-message headers the model can regex-target
 *   protected prefix         -> chrome + sentinel line + "original task" marker
 *   edit gate                -> diff at turn_end: edited file => applied, free
 *   editing reminder         -> context_status tool + [ctx ..] suffix on tool
 *                               results + one steer nudge per epoch at >=75%
 *   /compact                 -> cancelled; routed to the model as a steer:
 *                               "compact your context file now"
 *   overflow                 -> falls back to Pi's default compaction (safe)
 *
 * Disable with PI_CTX=off. Everything is wrapped so any internal error falls
 * back to Pi's default behavior.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const SENTINEL = "# ===== your live context — everything below this line is what the model sees =====";
const NUDGE_PERCENT = 75; // steer a reminder at/above this usage (once per epoch)
const NUDGE_COOLDOWN_TURNS = 10; // or after this many turns since the last nudge

interface CtxState {
	dir: string;
	file: string;
	bak: string;
	ready: boolean;
	lastRendered: string | null; // content region we last wrote/rendered
	renderedCount: number; // proj.messages length covered by lastRendered
	counter: number; // last [[CTX_TURN n]] number used
	appliedCount: number; // times a model edit was applied
	nudgeAt: { applied: number; turn: number }; // nudge bookkeeping
	disabled: boolean; // set on internal error -> stop interfering
}

const state: CtxState = {
	dir: "",
	file: "",
	bak: "",
	ready: false,
	lastRendered: null,
	renderedCount: 0,
	counter: 0,
	sessionToken: 0, // bumped on session_start; invalidates deferred sends
	appliedCount: 0,
	nudgeAt: { applied: 0, turn: -NUDGE_COOLDOWN_TURNS },
	disabled: false,
};

// ------------------------------------------------------------------ helpers

function textOf(content: string | Array<{ type: string; text?: string; thinking?: string; mimeType?: string }>): string {
	if (typeof content === "string") return content;
	return content
		.map((c) => {
			if (c.type === "text") return c.text ?? "";
			if (c.type === "thinking") return `<thinking>\n${c.thinking ?? ""}\n</thinking>`;
			if (c.type === "image") return "[image omitted from mirror]";
			return `[${c.type}]`;
		})
		.join("\n");
}

function serializeMessage(msg: any, n: number, isFirst: boolean): string {
	let role: string = msg.role ?? "message";
	let body: string;
	if (role === "user") {
		body = textOf(msg.content);
		if (isFirst) role = "user ORIGINAL-TASK";
	} else if (role === "assistant") {
		body = (msg.content ?? [])
			.map((c: any) => {
				if (c.type === "text") return c.text;
				if (c.type === "thinking") return `<thinking>\n${c.thinking ?? ""}\n</thinking>`;
				if (c.type === "toolCall") return `[tool call: ${c.name}(${JSON.stringify(c.arguments)})]`;
				return `[${c.type}]`;
			})
			.join("\n");
	} else if (role === "toolResult") {
		role = `tool_result ${msg.toolName ?? ""}${msg.isError ? " ERROR" : ""}`.trim();
		body = textOf(msg.content ?? "");
	} else if (typeof msg.customType === "string") {
		role = `custom:${msg.customType}`;
		body = textOf(msg.content ?? "");
	} else {
		body = JSON.stringify(msg).slice(0, 2000);
	}
	body = body.trim();
	return body ? `[[CTX_TURN ${n} role=${role}]]\n${body}` : `[[CTX_TURN ${n} role=${role}]] (empty)`;
}

function maxTurnNumber(text: string): number {
	let max = 0;
	for (const m of text.matchAll(/\[\[CTX_TURN (\d+)/g)) max = Math.max(max, Number(m[1]));
	return max;
}

const trimEnd = (s: string) => s.replace(/\s+$/, "");

function readContent(): string | null {
	try {
		if (!fs.existsSync(state.file)) return null;
		const raw = fs.readFileSync(state.file, "utf8");
		const i = raw.indexOf(SENTINEL);
		return (i >= 0 ? raw.slice(i + SENTINEL.length) : raw).replace(/^\n+/, "");
	} catch {
		return null;
	}
}

function usageLine(ctx: ExtensionContext): string {
	const u = ctx.getContextUsage();
	if (!u || u.tokens == null) return "context usage unknown (just compacted?)";
	return `~${Math.round(u.tokens / 1000)}k/${Math.round(u.contextWindow / 1000)}k tokens (${u.percent ?? "?"}%)`;
}

function chrome(ctx: ExtensionContext): string {
	return [
		"# ═══ LIVE CONTEXT FILE (pi-ctx) ═══",
		"# This file is the model's conversation. When the model edits it, the edit",
		"# is applied as its real context before its next turn (retain-none compaction).",
		"# Raw session history is preserved in the session file regardless of edits.",
		`# Usage: ${usageLine(ctx)} · applied edits: ${state.appliedCount} · session: ${path.basename(state.dir)}`,
		SENTINEL,
		"",
	].join("\n");
}

function writeContent(ctx: ExtensionContext, content: string): void {
	fs.mkdirSync(state.dir, { recursive: true });
	fs.writeFileSync(state.file, chrome(ctx) + content.replace(/\s*$/, "") + "\n");
}

function carriedText(msg: any): string {
	// Compaction/branch summary messages carry their text in `.summary`.
	return typeof msg.summary === "string" ? msg.summary : textOf(msg.content ?? "");
}

function render(ctx: ExtensionContext): string {
	// Canonical full render from the session projection. Compaction/branch
	// summary messages are carried verbatim (they already contain turn headers);
	// everything after them gets fresh [[CTX_TURN n]] headers.
	const proj = ctx.sessionManager.buildSessionProjection();
	let out = "";
	let base = 0;
	let count = 0;
	for (const pe of proj.entries) {
		const carried = pe.sourceEntry.type === "compaction" || pe.sourceEntry.type === "branch_summary";
		for (const msg of pe.messages) {
			count += 1;
			if (msg.role === "system") continue; // the prompt lives outside the mirror
			if (carried) {
				out += (out ? "\n\n" : "") + carriedText(msg).trim();
				base = maxTurnNumber(out);
			} else {
				base += 1;
				out += (out ? "\n\n" : "") + serializeMessage(msg, base, out === "");
			}
		}
	}
	state.counter = base;
	state.renderedCount = count;
	return out;
}

function nudgeText(ctx: ExtensionContext, extra?: string): string {
	return (
		`[context management] Your context is ${usageLine(ctx)}. Compact it now: edit ${state.file} ` +
		`to keep only what matters (key findings, decisions, current plan, active state) and drop ` +
		`stale bulk — huge tool outputs, dead ends, superseded notes. Protect the original task. ` +
		`Batch it into one edit; the edit applies before your next turn.` +
		(extra ? ` Focus: ${extra}` : "")
	);
}

// ------------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	if (process.env.PI_CTX === "off") return;

	const fail = (ctx: ExtensionContext, e: unknown, where: string) => {
		state.disabled = true;
		try {
			ctx.ui.notify(`pi-ctx disabled after error in ${where}: ${e instanceof Error ? e.message : String(e)}`, "error");
		} catch {
			/* non-UI mode */
		}
	};

	pi.on("session_start", (event, ctx) => {
		try {
			state.dir = path.join(os.homedir(), ".pi", "agent", "ctx", ctx.sessionManager.getSessionId());
			state.file = path.join(state.dir, "context.md");
			state.bak = state.file + ".bak";
			state.ready = true;
			state.lastRendered = null;
			state.counter = 0;
			state.sessionToken += 1;
			state.appliedCount = 0;
			state.nudgeAt = { applied: 0, turn: -NUDGE_COOLDOWN_TURNS };
			state.disabled = false;
		} catch (e) {
			fail(ctx, e, "session_start");
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!state.ready || state.disabled) return;
		// Teach the mechanism (paper: method skill in the system prompt).
		event.systemPromptOptions.appendSystemPrompt +=
			`\n\n## Managing your context (context-as-file)\n` +
			`Your conversation is mirrored to \`${state.file}\`. **Free up context by editing that file** — ` +
			`replace stale regions (large tool outputs, dead ends, superseded notes) with concise, specific summaries. ` +
			`When your turn ends, the file's content becomes your live context: what you removed is gone from context ` +
			`(the raw history is still preserved on disk for the user). An edit that matches nothing is wasted.\n` +
			`- **Never** read/cat the mirror file — its content is already in your context.\n` +
			`- Locate text by its \`[[CTX_TURN n role=…]]\` headers or short unique lines. Use your edit tool with exact ` +
			`oldText, or bash+python regex for bulk rewrites. Keep the \`[[CTX_TURN …]]\` header of any turn you keep; ` +
			`emptying a turn's body drops it. Protect the original task.\n` +
			`- Compact head + tail together in one edit: an edit forces everything *after* it to be re-read, so batching ` +
			`is much cheaper than many small edits. Be generous in replacement text — the tail is re-read anyway.\n` +
			`- Watch the \`[ctx …]\` tag on tool results; call \`context_status\` for details. Compact before the window fills.\n` +
			`- \`/compact [instructions]\` reaches you as a request to compact the file now.`;
	});

	pi.on("turn_start", (event, ctx) => {
		if (!state.ready || state.disabled) return;
		try {
			const content = render(ctx);
			writeContent(ctx, content);
			state.lastRendered = content;
		} catch (e) {
			fail(ctx, e, "turn_start");
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!state.ready || state.disabled || state.lastRendered == null) return;
		try {
			// Serialize everything the projection gained since the last render
			// (the new user prompt, steer deliveries, this turn's message + tool
			// results). turn_start fires before the prompt is persisted, so slicing
			// the projection — not event.message — is what keeps the mirror
			// faithful when the model compacts in a run's first turn.
			const proj = ctx.sessionManager.buildSessionProjection();
			const fresh = proj.messages.slice(state.renderedCount);
			let add = "";
			for (const msg of fresh) {
				const isFirstOverall =
					state.counter === 0 && (state.lastRendered ?? "") === "" && add === "" && msg.role === "user";
				state.counter += 1;
				add += (add ? "\n\n" : "") + serializeMessage(msg, state.counter, isFirstOverall);
			}
			state.renderedCount = proj.messages.length;

			const current = readContent();
			if (current == null) {
				// File vanished (external deletion): recreate, do not apply — never
				// let an missing file empty the live context.
				writeContent(ctx, state.lastRendered + (add ? "\n\n" + add : ""));
				state.lastRendered = readContent();
				return;
			}

			if (current !== null && trimEnd(current) !== trimEnd(state.lastRendered ?? "")) {
				if (process.env.PI_CTX_DEBUG) {
					try {
						fs.writeFileSync(state.bak + ".debug-current", current);
						fs.writeFileSync(state.bak + ".debug-expected", state.lastRendered);
					} catch {}
				}
				// The model edited its context file: the file becomes the context.
				const summary = trimEnd(current) + (add ? "\n\n" + add : "");
				try {
					fs.mkdirSync(state.dir, { recursive: true });
					fs.copyFileSync(state.file, state.bak); // insurance against bad edits
				} catch {
					/* best effort */
				}
				writeContent(ctx, summary);
				state.lastRendered = summary;
				state.appliedCount += 1;
				return {
					entries: [
						{
							type: "compaction",
							summary,
							firstKeptEntryId: null,
							details: { ctx: true, appliedEdits: state.appliedCount },
						},
					],
				};
			}

			// Unedited: just keep the mirror in sync with the appended turn.
			const synced = trimEnd(current) + (add ? "\n\n" + add : "");
			writeContent(ctx, synced);
			state.lastRendered = synced;

			// Editing reminder (paper: nudge near the budget, once per epoch).
			const u = ctx.getContextUsage();
			const dueSinceNudge =
				state.appliedCount > state.nudgeAt.applied || state.counter - state.nudgeAt.turn >= NUDGE_COOLDOWN_TURNS;
			if (u?.percent != null && u.percent >= NUDGE_PERCENT && dueSinceNudge) {
				state.nudgeAt = { applied: state.appliedCount, turn: state.counter };
				pi.sendUserMessage(nudgeText(ctx), { deliverAs: "steer" });
			}
			return;
		} catch (e) {
			fail(ctx, e, "turn_end");
		}
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!state.ready || state.disabled) return;
		const { reason, customInstructions } = event;
		// Overflow: never gamble — let Pi's default compaction recover.
		if (reason === "overflow") return;
		// One routed attempt per epoch; after that, default compaction runs.
		const canNudge = state.appliedCount > state.nudgeAt.applied || state.counter - state.nudgeAt.turn >= NUDGE_COOLDOWN_TURNS;
		if (!canNudge) return;
		state.nudgeAt = { applied: state.appliedCount, turn: state.counter };
		const message =
			reason === "manual"
				? nudgeText(ctx, customInstructions ? customInstructions : undefined) +
						" (The user ran /compact — treat this as the compaction request.)"
				: nudgeText(ctx);
		try {
			if (reason === "manual") {
				// The manual flow holds an abort controller that rejects prompts
				// until it unwinds, so defer the send past it. followUp starts a
				// run when idle and queues until settle when streaming.
				const token = state.sessionToken;
				setTimeout(() => {
					if (!state.ready || state.disabled || token !== state.sessionToken) return;
					try {
						pi.sendUserMessage(message, { deliverAs: "followUp" });
					} catch {
						/* runtime swallows its own errors; nothing to do */
					}
				}, 120);
			} else {
				// Threshold compaction mid-run: no controller is held; the steer
				// rides the catch-up poll before the next turn.
				pi.sendUserMessage(message, { deliverAs: "steer" });
			}
			ctx.ui.notify(
				`pi-ctx: compaction routed to the model — it will edit ${state.file}; applied after its next turn` +
					(reason === "manual" ? " (run /compact again to force default summarization)" : ""),
				"info",
			);
		} catch (e) {
			fail(ctx, e, "session_before_compact");
			return;
		}
		return { cancel: true };
	});

	// Paper's status_line: on-demand, model-callable usage readout.
	pi.registerTool({
		name: "context_status",
		label: "Context status",
		description:
			"Report your current context usage (tokens, window, percent) and remind you of the mirror-file path. Call it before deciding whether to compact your context file.",
		promptSnippet: "report live context usage",
		parameters: Type.Object({}),
		execute: async (_id, _params, _signal, _onUpdate, ctx) => {
			const line = `${usageLine(ctx)} · mirror: ${state.file} · applied edits: ${state.appliedCount}`;
			return {
				content: [{ type: "text", text: line }],
				details: undefined,
			};
		},
	});

	// Paper: "every tool result reports your current size."
	pi.on("tool_result", (event, ctx) => {
		if (!state.ready || state.disabled || event.parentToolCallId) return;
		try {
			const u = ctx.getContextUsage();
			if (!u || u.tokens == null) return;
			const tag = `[ctx ~${Math.round(u.tokens / 1000)}k/${Math.round(u.contextWindow / 1000)}k ${u.percent ?? "?"}%]`;
			const content = [...event.content];
			const lastText = content.findLastIndex((c) => c.type === "text");
			if (lastText >= 0) {
				const c: any = content[lastText];
				content[lastText] = { ...c, text: `${c.text}\n\n${tag}` };
			} else {
				content.push({ type: "text", text: tag });
			}
			return { content };
		} catch {
			return;
		}
	});
}
