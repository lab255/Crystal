import { describe, expect, it, vi } from "vitest";
import { enterKeyAction } from "@crystal/client";
import { handleAgentConsoleKeydown, resizeAgentConsoleInput } from "./TerminalPanel.js";

function keyEvent(
  key: string,
  modifiers: Partial<Pick<React.KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">> = {},
) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...modifiers,
  } as unknown as React.KeyboardEvent<HTMLTextAreaElement>;
}

describe("agent console composer", () => {
  it("delegates Enter variants to the shared composer keymap", () => {
    const sent: string[] = [];
    const line = "first line\nsecond line";
    const composer = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (enterKeyAction(event, "mod-enter") === "send") sent.push(line);
    };
    const historyIndex = { current: 0 };

    handleAgentConsoleKeydown(keyEvent("Enter"), [], historyIndex, vi.fn(), composer);
    handleAgentConsoleKeydown(
      keyEvent("Enter", { shiftKey: true }),
      [],
      historyIndex,
      vi.fn(),
      composer,
    );
    handleAgentConsoleKeydown(
      keyEvent("Enter", { ctrlKey: true }),
      [],
      historyIndex,
      vi.fn(),
      composer,
    );

    expect(sent).toEqual([line]);
  });

  it("grows to its content and caps tall prompts", () => {
    const input = { scrollHeight: 58, style: { height: "", overflowY: "" } };
    resizeAgentConsoleInput(input as unknown as HTMLTextAreaElement);
    expect(input.style).toEqual({ height: "58px", overflowY: "hidden" });

    input.scrollHeight = 140;
    resizeAgentConsoleInput(input as unknown as HTMLTextAreaElement);
    expect(input.style).toEqual({ height: "96px", overflowY: "auto" });
  });
});
