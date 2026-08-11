// Auth-method segmented choice + show_when field visibility (Bedrock's "Connect with"):
// only the selected method's fields render, and clicking a segment switches them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KEY_HELP, ProviderForm, type ProviderSetupState } from "./ProviderSetup";
import type { ProviderInfo } from "../api";

vi.mock("../tauri", () => ({ openExternal: vi.fn() }));
import { openExternal } from "../tauri";

afterEach(cleanup);

const BEDROCK: ProviderInfo = {
  name: "bedrock",
  title: "AWS Bedrock",
  needs_key: true,
  configured: false,
  values: {},
  suggested_models: [],
  recommended_model: null,
  fields: [
    { key: "region", label: "AWS region", secret: false, required: true, help: "", placeholder: "us-east-1" },
    {
      key: "auth_method",
      label: "Connect with",
      secret: false,
      required: false,
      help: "",
      placeholder: "",
      default: "api_key",
      choices: [
        { value: "api_key", label: "Bedrock API key" },
        { value: "profile", label: "AWS profile" },
        { value: "iam", label: "IAM keys" },
      ],
    },
    { key: "bedrock_api_key", label: "Bedrock API key", secret: true, required: false, help: "", placeholder: "ABSK…", show_when: { auth_method: "api_key" } },
    { key: "aws_profile", label: "AWS profile", secret: false, required: false, help: "", placeholder: "default", show_when: { auth_method: "profile" } },
    { key: "aws_secret_access_key", label: "Secret access key", secret: true, required: false, help: "", placeholder: "", show_when: { auth_method: "iam" } },
  ],
};

const VOLCENGINE: ProviderInfo = {
  name: "volcengine",
  title: "Volcengine Ark (Agent Plan)",
  needs_key: true,
  configured: false,
  values: {},
  suggested_models: [],
  recommended_model: "ark-code-latest",
  fields: [
    { key: "api_key", label: "Volcengine API key", secret: true, required: true, help: "", placeholder: "" },
    { key: "base_url", label: "Endpoint", secret: false, required: false, help: "", placeholder: "" },
  ],
};

function makePs(
  fields: Record<string, string>,
  setFieldValue = vi.fn(),
  provider = BEDROCK,
): ProviderSetupState {
  return {
    providers: [provider],
    ordered: [provider],
    providerOrder: null,
    swapProviders: () => {},
    clearProviderOrderNotice: () => {},
    refreshProviders: async () => {},
    sel: provider.name,
    info: provider,
    fields,
    setFieldValue,
    dirty: false,
    verify: { state: "idle" },
    showEndpoint: false,
    setShowEndpoint: () => {},
    keylessOk: new Set(),
    credentialed: false,
    savedState: false,
    secretFilled: true,
    openProvider: () => {},
    backToGallery: () => {},
    runTestAndSave: async () => true,
    removeKey: async () => {},
    cancelBackTimer: () => {},
    statusFor: () => null,
    saveField: async () => {},
    fieldSaved: null,
  };
}

describe("ProviderForm auth-method choice", () => {
  it("renders only the selected method's fields", () => {
    render(<ProviderForm ps={makePs({ auth_method: "api_key" })} tp="t" />);
    expect(screen.getByTestId("t-field-bedrock_api_key")).toBeTruthy();
    expect(screen.queryByTestId("t-field-aws_profile")).toBeNull();
    expect(screen.queryByTestId("t-field-aws_secret_access_key")).toBeNull();
    expect(screen.getByTestId("t-choice-auth_method-api_key").getAttribute("aria-checked")).toBe("true");
  });

  it("switching the segment swaps the visible fields", () => {
    const setFieldValue = vi.fn();
    const { rerender } = render(
      <ProviderForm ps={makePs({ auth_method: "api_key" }, setFieldValue)} tp="t" />,
    );
    fireEvent.click(screen.getByTestId("t-choice-auth_method-profile"));
    expect(setFieldValue).toHaveBeenCalledWith("auth_method", "profile");
    rerender(<ProviderForm ps={makePs({ auth_method: "profile" }, setFieldValue)} tp="t" />);
    expect(screen.getByTestId("t-field-aws_profile")).toBeTruthy();
    expect(screen.queryByTestId("t-field-bedrock_api_key")).toBeNull();
  });

  it("iam segment shows the key-pair fields", () => {
    render(<ProviderForm ps={makePs({ auth_method: "iam" })} tp="t" />);
    expect(screen.getByTestId("t-field-aws_secret_access_key")).toBeTruthy();
    expect(screen.queryByTestId("t-field-bedrock_api_key")).toBeNull();
  });
});

describe("provider key help", () => {
  it("opens Volcengine's dedicated Agent Plan key page", () => {
    const url =
      "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=agentEnterprise";
    expect(KEY_HELP.volcengine.url).toBe(url);

    render(
      <ProviderForm
        ps={makePs({ api_key: "", base_url: "" }, vi.fn(), VOLCENGINE)}
        tp="t"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Create one at/ }));

    expect(openExternal).toHaveBeenCalledWith(url);
  });
});
