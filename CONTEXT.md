# Project Context

## Domain glossary

### Coding agent

The Grok-powered assistant that explores a local project, proposes or applies file changes, runs commands, and reports progress to the user.

### Project

A single local folder opened by the app as the agent's working scope. V1 has one active project per app window.

### Session

One interactive coding-agent run for the current project. Session state includes the conversation, activity, approvals, cancellation state, and whether YOLO mode is enabled.

### Approval

The user's explicit authorization for an agent action that is not automatically allowed by the safety policy, such as applying an edit or running a command.

### YOLO mode

An explicitly enabled, per-session mode that removes normal per-action approval prompts while retaining visible activity, diffs, cancellation, and an emergency stop.

### Activity panel

The integrated view of agent progress, tool events, command output, approvals, errors, and cancellation state. It replaces the need for a separate TUI during normal use.

### CLI fallback

The existing Grok CLI remains available when the GUI does not yet cover a workflow or when the user prefers the terminal.

### Agent engine

The runtime that executes a coding-agent session for a Project. V1 uses the official Grok Build CLI behind the app-owned adapter; the GUI should not depend on TUI presentation output.

### ACP bridge

The app-owned boundary that starts the Agent engine, exchanges structured session messages, forwards approvals, streams activity, and controls cancellation and cleanup.
