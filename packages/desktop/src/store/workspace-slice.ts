/**
 * Which project the app is pointed at.
 *
 * Opening a workspace is not just a path: it decides which sessions are listed, which paths every
 * guard will accept, and what the sidebar shows. So these actions all end by refreshing the same
 * few pieces of state, and they are together because forgetting one of them is the bug.
 */

import type { ProjectEntry, SessionMeta } from "@deepwise/core";
import { prune, rebuildToolRuns, todosFrom, wasCutShort, without } from "./derive.ts";
import type { AppState } from "../store.ts";

type Get = () => AppState;
type Set = (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

export function workspaceSlice(set: Set, get: Get) {
  return {
  async pickWorkspace() {
    const workspace = await window.deepwise.workspace.pick();
    if (!workspace) return;
    await get().openWorkspace(workspace.path);
  },

  async openWorkspace(path: string) {
    const workspace = await window.deepwise.workspace.info(path);
    if (!workspace) return;
    const settings = get().settings;
    if (settings) {
      const projects = settings.projects.filter((p) => p.path !== path);
      await get().saveSettings({
        ...settings,
        projects: [
          {
            id: path,
            name: workspace.name,
            path,
            pinned:
              settings.projects.find((p) => p.path === path)?.pinned ?? false,
            lastOpenedAt: Date.now(),
          },
          ...projects,
        ],
      });
    }
    set({
      workspace,
      activeSessionId: null,
      meta: null,
      messages: [],
      toolRuns: {},
      approvals: [],
      loadingSession: false,
      pendingUserMessage: null,
    });
  },

  async refreshWorkspace() {
    const current = get().workspace;
    if (!current) return;
    const workspace = await window.deepwise.workspace.info(current.path);
    if (workspace) set({ workspace });
  },

  clearWorkspace() {
    set({
      workspace: null,
      activeSessionId: null,
      meta: null,
      messages: [],
      toolRuns: {},
      approvals: [],
      loadingSession: false,
      pendingUserMessage: null,
    });
  },

  async renameProject(path: string, name: string) {
    const settings = get().settings;
    const trimmed = name.trim();
    if (!settings || !trimmed) return;
    await get().saveSettings({
      ...settings,
      projects: settings.projects.map((p) =>
        p.path === path ? { ...p, name: trimmed } : p,
      ),
    });
    // The header reads the workspace, not the project list, so it needs telling separately.
    const workspace = get().workspace;
    if (workspace?.path === path)
      set({ workspace: { ...workspace, name: trimmed } });
  },

  async setProjectPinned(path: string, pinned: boolean) {
    const settings = get().settings;
    if (!settings) return;
    await get().saveSettings({
      ...settings,
      projects: settings.projects.map((p) =>
        p.path === path ? { ...p, pinned } : p,
      ),
    });
  },

  async removeProject(path: string) {
    const settings = get().settings;
    if (!settings) return;
    // Only the entry goes. The sessions and the directory itself are left alone — this is
    // "stop listing this", not "delete my work".
    await get().saveSettings({
      ...settings,
      projects: settings.projects.filter((p) => p.path !== path),
    });
    if (get().workspace?.path === path) get().clearWorkspace();
  },

  async archiveProjectSessions(path: string) {
    const targets = get().sessions.filter((s) => s.cwd === path && !s.archived);
    if (targets.length === 0) return;
    set({
      sessions: get().sessions.map((s) =>
        s.cwd === path && !s.archived ? { ...s, archived: true } : s,
      ),
    });
    if (targets.some((s) => s.id === get().activeSessionId)) {
      set({
        activeSessionId: null,
        meta: null,
        messages: [],
        toolRuns: {},
        approvals: [],
        loadingSession: false,
        pendingUserMessage: null,
      });
    }
    // Sequential rather than parallel: each call rewrites the shared session index.
    let latest = get().sessions;
    for (const session of targets) {
      latest = await window.deepwise.sessions.setArchived(
        session.projectId,
        session.id,
        true,
      );
    }
    set({ sessions: latest });
    get().notify(`已归档 ${targets.length} 个聊天`);
  },
  };
}

