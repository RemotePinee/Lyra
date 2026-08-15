import type { PermissionMode } from "@lyra/core";
import { useEffect, useState } from "react";
import { useApp } from "../../store.ts";
import {
  Card,
  InlineSelect,
  Row,
  SectionTitle,
  Segmented,
  Toggle,
} from "./controls.tsx";

const EDITORS = [
  "Zed",
  "Cursor",
  "Visual Studio Code",
  "Finder",
  "Terminal",
  "Ghostty",
  "Xcode",
];

/**
 * Each application's own icon, read from the copy installed on this machine.
 *
 * Rather than shipping our own drawings of other people's logos: this is the icon already in
 * the user's Dock, at whatever version they have, and it costs nothing to keep current. An app
 * that is not installed simply has none, and its row stays a plain label.
 */
function useAppIcons(names: string[]): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>({});
  const key = names.join("|");

  useEffect(() => {
    let live = true;
    void Promise.all(
      names.map(
        async (name) =>
          [name, await window.lyra.system.appIcon(name)] as const,
      ),
    ).then((pairs) => {
      if (!live) return;
      setIcons(
        Object.fromEntries(
          pairs.filter((pair): pair is [string, string] => Boolean(pair[1])),
        ),
      );
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return icons;
}

export function GeneralSettings() {
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const [platform, setPlatform] = useState("darwin");
  const editorIcons = useAppIcons(EDITORS);

  useEffect(() => {
    void window.lyra.system.platform().then(setPlatform);
  }, []);

  if (!settings) return null;

  const mode = settings.permissionMode;
  const patch = (next: Partial<typeof settings>) =>
    void saveSettings({ ...settings, ...next });
  const setMode = (permissionMode: PermissionMode) => patch({ permissionMode });

  return (
    <div className="pt-8">
      <h1 className="pb-7 text-[26px] leading-tight font-semibold tracking-tight text-ink">
        常规
      </h1>

      <SectionTitle>权限</SectionTitle>
      <Card className="mb-9">
        {/*
         * A statement, not a switch.
         *
         * This was a `Toggle` wired to an empty handler — permanently on and inert, because
         * what it describes is not configurable: reading the open workspace is the floor the
         * agent stands on. A control that cannot move is worse than no control, since it
         * invites the one click that proves it does nothing.
         */}
        <Row
          title="默认权限"
          detail="Lyra 始终可以读取和编辑当前工作区内的文件。需要时它会请求额外的访问权限。"
          control={
            <span className="text-[12.5px] text-ink-faint">始终开启</span>
          }
        />
        <Row
          title="自动审核"
          detail="只读命令（git status、ls、grep 等）自动放行，写入和未知命令仍会请求批准。"
          control={
            <Toggle
              checked={mode !== "ask"}
              onChange={(on) => setMode(on ? "auto" : "ask")}
            />
          }
        />
        <Row
          title="完整访问权限"
          detail="开启后 Lyra 无需批准即可修改文件、执行命令并访问网络。这会显著提高数据丢失或意外行为的风险。"
          control={
            <Toggle
              checked={mode === "full"}
              onChange={(on) => setMode(on ? "full" : "auto")}
            />
          }
        />
      </Card>

      <SectionTitle>常规</SectionTitle>
      <Card>
        <Row
          title="默认文件打开目标"
          detail="点击文件路径时用哪个应用打开"
          control={
            <InlineSelect
              value={settings.editor.defaultOpenTarget}
              onChange={(defaultOpenTarget) =>
                patch({ editor: { ...settings.editor, defaultOpenTarget } })
              }
              options={EDITORS.map((name) => ({
                value: name,
                label: name,
                icon: editorIcons[name] ? (
                  <img
                    src={editorIcons[name]}
                    alt=""
                    className="h-[18px] w-[18px] shrink-0 rounded-[4px]"
                  />
                ) : undefined,
              }))}
            />
          }
        />
        <Row
          title="默认推理强度"
          detail="新会话使用的思考预算，可在输入框右侧随时切换"
          control={
            <Segmented
              value={settings.thinking}
              onChange={(thinking) => patch({ thinking })}
              options={[
                { value: "off", label: "关" },
                { value: "low", label: "低" },
                { value: "medium", label: "中" },
                { value: "high", label: "高" },
              ]}
            />
          }
        />
        <Row
          title="请求重试次数"
          detail="模型请求因网络中断失败时的重试次数（含首次）。中继或代理不稳时值得调高；设为 1 则失败立即报错。已经开始输出的回答不会重试。"
          control={
            <Segmented
              value={String(settings.retryAttempts)}
              onChange={(value) => patch({ retryAttempts: Number(value) })}
              options={[
                { value: "1", label: "不重试" },
                { value: "2", label: "2 次" },
                { value: "3", label: "3 次" },
                { value: "5", label: "5 次" },
              ]}
            />
          }
        />
        <Row
          title="底部面板"
          detail="在会话底部显示用量与状态信息"
          control={
            <Toggle
              checked={settings.editor.showBottomPanel}
              onChange={(showBottomPanel) =>
                patch({ editor: { ...settings.editor, showBottomPanel } })
              }
            />
          }
        />
        <Row
          title="平台"
          detail="当前运行环境"
          control={
            <span className="text-[12.5px] text-ink-faint">{platform}</span>
          }
        />
      </Card>
    </div>
  );
}
