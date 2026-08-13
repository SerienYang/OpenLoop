import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";

const baseProps = {
  mode: "interactive",
  model: "gpt-5.6-sol",
  running: true,
  connected: true,
  sessionId: "s1",
  onSend: vi.fn(),
  onInterrupt: vi.fn(),
  onModeChange: vi.fn(),
  onModelChange: vi.fn(),
};

afterEach(cleanup);

describe("Composer question answer mode", () => {
  it("submits text and attachments while the current turn is running", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ status: "accepted" });
    render(
      <Composer
        {...baseProps}
        prefill={{
          text: "",
          attachments: [
            {
              kind: "image",
              name: "reference.png",
              data_url: "data:image/png;base64,AA==",
            },
          ],
          nonce: 1,
        }}
        questionAnswer={{
          itemId: "question-1",
          sessionId: "s1",
          onSubmit,
        }}
      />,
    );

    const input = screen.getByPlaceholderText("Answer the current question…");
    fireEvent.change(input, { target: { value: "Use this reference" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1]).toBe("Use this reference");
    expect(onSubmit.mock.calls[0][2][0].name).toBe("reference.png");
    expect(baseProps.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("keeps the draft until accepted and preserves it after rejection", async () => {
    let finish: (value: { status: string }) => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<{ status: string }>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <Composer
        {...baseProps}
        questionAnswer={{
          itemId: "question-1",
          sessionId: "s1",
          onSubmit,
        }}
      />,
    );

    const input = screen.getByPlaceholderText("Answer the current question…") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "My answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(input.value).toBe("My answer");
    expect(screen.getByRole("button", { name: "Answer" }).hasAttribute("disabled")).toBe(true);

    finish({ status: "rejected" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Answer" }).hasAttribute("disabled")).toBe(false));
    expect(input.value).toBe("My answer");
  });

  it("a late accepted response cannot clear a new session draft", async () => {
    let finish: (value: { status: string }) => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<{ status: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender } = render(
      <Composer
        {...baseProps}
        resetKey="s1"
        questionAnswer={{ itemId: "question-1", sessionId: "s1", onSubmit }}
      />,
    );
    const input = screen.getByPlaceholderText("Answer the current question…");
    fireEvent.change(input, { target: { value: "Old answer" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    rerender(
      <Composer
        {...baseProps}
        resetKey="s1"
        questionAnswer={undefined}
      />,
    );
    rerender(
      <Composer
        {...baseProps}
        resetKey="s1"
        questionAnswer={undefined}
      />,
    );
    rerender(
      <Composer
        {...baseProps}
        running={false}
        resetKey="s2"
        questionAnswer={undefined}
        prefill={{ text: "New session draft", nonce: 2 }}
      />,
    );
    await waitFor(() =>
      expect(
        (screen.getByDisplayValue("New session draft") as HTMLTextAreaElement).value,
      ).toBe("New session draft"),
    );
    finish({ status: "accepted" });

    await waitFor(() =>
      expect(
        (screen.getByDisplayValue("New session draft") as HTMLTextAreaElement).value,
      ).toBe("New session draft"),
    );
  });

  it("clears the prior answer when the agent advances to a new question", async () => {
    const onSubmit = vi.fn(
      () => new Promise<{ status: string }>(() => {}),
    );
    const { rerender } = render(
      <Composer
        {...baseProps}
        resetKey="s1"
        questionAnswer={{ itemId: "question-1", sessionId: "s1", onSubmit }}
      />,
    );
    const firstInput = screen.getByPlaceholderText(
      "Answer the current question…",
    ) as HTMLTextAreaElement;
    fireEvent.change(firstInput, { target: { value: "Answer for question one" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));

    rerender(
      <Composer
        {...baseProps}
        resetKey="s1"
        questionAnswer={{ itemId: "question-2", sessionId: "s1", onSubmit }}
      />,
    );

    await waitFor(() =>
      expect(
        (
          screen.getByPlaceholderText(
            "Answer the current question…",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe(""),
    );
    expect(screen.getByRole("button", { name: "Answer" }).hasAttribute("disabled")).toBe(true);
  });
});
