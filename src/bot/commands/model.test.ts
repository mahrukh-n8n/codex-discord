import { describe, expect, it } from "vitest";
import {
  getModelAutocompleteChoices,
  getReasoningAutocompleteChoices,
  type CachedCodexModel,
} from "./model.js";

const models: CachedCodexModel[] = [
  {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    supported_reasoning_levels: [
      { effort: "low" },
      { effort: "medium" },
      { effort: "high" },
      { effort: "xhigh" },
    ],
  },
  {
    slug: "o4-mini",
    display_name: "o4 mini",
    supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
  },
];

describe("model command autocomplete", () => {
  it("lists default and cached models", () => {
    const choices = getModelAutocompleteChoices(models, "");

    expect(choices[0]).toEqual({ name: "default", value: "default" });
    expect(choices).toContainEqual({ name: "GPT-5.5 (gpt-5.5)", value: "gpt-5.5" });
    expect(choices).toContainEqual({ name: "o4 mini (o4-mini)", value: "o4-mini" });
  });

  it("filters models by slug or display name", () => {
    expect(getModelAutocompleteChoices(models, "mini")).toEqual([
      { name: "default", value: "default" },
      { name: "o4 mini (o4-mini)", value: "o4-mini" },
    ]);
  });

  it("uses selected model reasoning levels including xhigh", () => {
    expect(getReasoningAutocompleteChoices(models, "gpt-5.5", "")).toEqual([
      { name: "default", value: "default" },
      { name: "low", value: "low" },
      { name: "medium", value: "medium" },
      { name: "high", value: "high" },
      { name: "xhigh", value: "xhigh" },
    ]);
  });

  it("falls back to common reasoning levels when no cached model is selected", () => {
    expect(getReasoningAutocompleteChoices(models, null, "hi")).toEqual([
      { name: "high", value: "high" },
      { name: "xhigh", value: "xhigh" },
    ]);
  });
});
