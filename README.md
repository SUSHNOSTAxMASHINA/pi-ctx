# pi-ctx — context-as-file for pi

A [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that replaces `/compact` + auto-compact with a context file the model manages itself (the "context language model" method — [arXiv:2609.37725](https://arxiv.org/abs/2609.37725)).

The live conversation is mirrored to `~/.pi/agent/ctx/<sessionId>/context.md`. The model edits that file to compact its own context; at turn end the edit is applied as a retain-none compaction — the file's content becomes the live context, with **no summarizer LLM call**. Raw session history is preserved on disk regardless of edits.

- `/compact [instructions]` is routed to the model as a compaction request (run it twice to force pi's default summarization)
- `context_status` tool reports live usage; every tool result carries a `[ctx …]` tag
- one editing nudge per epoch at ≥75% usage
- overflow falls back to pi's default compaction (safe)
- applied edits are backed up to `context.md.bak`

## Install

Copy `pi-ctx.ts` into `~/.pi/agent/extensions/`, then run `/reload`.

Disable with `PI_CTX=off`. Set `PI_CTX_DEBUG` to dump applied-vs-expected mirror state for debugging.

## License

[PolyForm Noncommercial 1.0.0](./LICENSE) — free to use, study, and modify for non-commercial purposes.