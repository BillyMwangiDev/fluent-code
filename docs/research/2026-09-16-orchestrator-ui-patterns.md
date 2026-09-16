# Navigation and status patterns in agent orchestrators, IDEs and TUIs

Research note, 2026-09-16, written to ground the rail redesign and the next workspace decisions.
Sources are linked inline; findings are paraphrased unless quoted.

## What the best tools in the category do

**Claude Code desktop (Anthropic, 2026 redesign).** The redesign puts "every active and recent
session in one place" in a new sidebar; sessions can be grouped by status, project or environment,
and a session "archives itself" when its PR merges or closes "so the sidebar stays focused on what's
live". Three view densities (Verbose / Normal / Summary) trade transparency for calm, a usage button
shows context-window and session usage at a glance, and `⌘ /` lists the shortcuts.
Source: [Redesigning Claude Code on desktop for parallel agents](https://claude.com/blog/claude-code-desktop-redesign).

**T3 Code.** Three panels: a sidebar for projects and threads, the thread list, and the
conversation. Threads sit under their project, carry colour-coded state badges (working, pending
approval, completed, terminal running), and a right-click menu handles rename / mark unread / delete.
Shortcuts show in tooltips. "Add Project" lives at the bottom of the sidebar.
Sources: [T3 Code web interface guide](https://mintlify.wiki/pingdotgg/t3code/guides/web-interface),
[Better Stack's overview](https://betterstack.com/community/guides/ai/t3-code/).

**Conductor.** Also three panels: a left sidebar of workspaces (each an isolated worktree), the
chat in the middle, and a right panel with the live diff and an integrated terminal. Every
workspace has its own branch, agent and state.
Source: [Running many coding agents in parallel with Conductor](https://julianastrada.com/blog/conductor-parallel-agents/).

**Terminal multiplexers for agents (cmux, termany).** The recurring problem is "which pane needs
me": termany tags each pane working / done / needs-attention from the running job rather than the
shell prompt, and cmux flashes a coloured ring around the pane that needs input while its sidebar
tab lights up at the same time — a layered signal instead of a notification storm.
Source: [cmux, ACPX, and OMX: the three layers of multi-agent UX](https://codex.danielvaughan.com/2026/04/09/cmux-acpx-omx-three-layers-multi-agent-ux/).

**IDEs (VS Code, Zed, Cursor).** An activity bar of icons with a collapsible side panel is the
shared grammar; Zed's minimalism is praised precisely because auxiliary panels stay out of the way.
Sidebar guidance that holds across SaaS and tools: collapsible to an icon-only state with tooltips,
200–300 ms transitions, remember the choice, and switch to a different pattern below tablet width.
Sources: [Sidebar design best practices](https://www.alfdesigngroup.com/post/improve-your-sidebar-design-for-web-apps),
[Zed vs Cursor](https://zed.dev/compare/cursor).

**TUI principles.** Spatial consistency (users navigate by location memory within a minute),
keyboard-first with the mouse as a real option, a sidebar that toggles with one key, and progressive
disclosure of shortcuts — a footer with the three to five keys that matter, the rest one key away.
Source: [The terminal renaissance: designing beautiful TUIs](https://hyperbliss.tech/blog/2026.04.04_terminal-renaissance/).

## What this means for Fluent's rail

1. **Brand at the top of the rail, not the top bar.** Every tool above anchors identity in the
   sidebar; the top bar is for the current context and global actions. Done.
2. **Icon + label items, collapsible to an icon rail.** One key (⌘B), remembered across launches,
   200 ms, tooltips carry the labels when collapsed. Done.
3. **Sections by spacing and a quiet label, not rules.** Divider lines add visual weight without
   information; the group label plus 14 px of air reads faster. Done.
4. **Lanes are the sidebar's live content, grouped by project, main agent first.** This is what
   Claude Code desktop and T3 do with sessions/threads. Fluent already had it; the redesign keeps
   it and adds the attention count on the orchestrate item, so "something needs me" is visible from
   any screen — the cmux lesson.
5. **A workspace switcher, not a bare folder button.** Projects with running lanes are one click
   away; browsing for a folder is the last item.
6. **The footer carries state and the one shortcut that matters here**, instead of a slogan.

## Not adopted, deliberately

- **Auto-archive on PR merge.** Attractive, but Fluent's sessions are not always tied to a PR;
  bulk archive from the sessions screen covers the need without guessing.
- **View-density modes for terminals.** The lane shows the CLI's own screen; density belongs to
  the CLI. The workspace already has grid / rows / focus, which is the equivalent knob.
- **A right-hand diff panel by default.** Conductor and T3 have one because their centre is a
  chat. Fluent's centre is the terminal; diffs stay in the session view.
