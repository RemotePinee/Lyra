/**
 * The panels that ship with the app.
 *
 * Registered like any other set, so there is nothing special about them beyond loading first —
 * which is exactly the property that lets a plugin replace one.
 */

import { Folder, GitCompare, Globe, History, ListTodo, MessageCirclePlus, SquareTerminal } from "lucide-react";

import { BrowserPanel } from "../components/BrowserPanel.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";
import { GitPanel } from "../components/git/GitPanel.tsx";
import { SideChat } from "../components/SideChat.tsx";
import { TaskPanel } from "../components/TaskPanel.tsx";
import { TerminalPane } from "../components/TerminalPane.tsx";
import { TrajectoryPanel } from "../components/trajectory/TrajectoryPanel.tsx";
import { registerPanels, type PanelDefinition } from "./registry.ts";

const needsWorkspace = (state: { workspace: boolean }) => (state.workspace ? undefined : "先打开一个项目");
/** A shell only needs a directory, and a project-less conversation has one. */
const needsCwd = (state: { cwd: boolean }) => (state.cwd ? undefined : "先打开一个项目");
const needsSession = (state: { session: boolean }) => (state.session ? undefined : "先开始一个对话");

const BUILTIN_PANELS: PanelDefinition[] = [
	{ kind: "files", label: "文件", icon: Folder, shortcut: "⌘P", unavailable: needsWorkspace, render: FileBrowser },
	{
		kind: "chat",
		label: "侧边聊天",
		icon: MessageCirclePlus,
		shortcut: "⌥⌘S",
		unavailable: needsSession,
		render: SideChat,
	},
	{
		kind: "terminal",
		label: "终端",
		icon: SquareTerminal,
		shortcut: "⌃`",
		unavailable: needsCwd,
		render: TerminalPane,
	},
	{ kind: "tasks", label: "任务", icon: ListTodo, shortcut: "⌘J", render: TaskPanel },
	{
		kind: "trajectory",
		label: "轨迹",
		icon: History,
		shortcut: "⌘L",
		unavailable: needsSession,
		render: TrajectoryPanel,
	},
	{ kind: "browser", label: "浏览器", icon: Globe, shortcut: "⌘T", render: BrowserPanel },
	{ kind: "review", label: "Git", icon: GitCompare, shortcut: "⌘⇧R", unavailable: needsWorkspace, render: GitPanel },
];

registerPanels(BUILTIN_PANELS);
