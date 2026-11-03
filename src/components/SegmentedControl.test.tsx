import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SegmentedControl } from "./SegmentedControl";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

describe("SegmentedControl", () => {
  it("marks the active option as selected", () => {
    render(<SegmentedControl value="dark" onChange={() => undefined} options={OPTIONS} label="Theme" />);
    const active = screen.getByRole("radio", { checked: true });
    expect(active).toHaveProperty("textContent", "Dark");
  });

  it("reports the chosen value when a segment is clicked", () => {
    const onChange = vi.fn();
    render(<SegmentedControl value="light" onChange={onChange} options={OPTIONS} label="Theme" />);
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(onChange).toHaveBeenCalledWith("system");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("groups the segments under one accessible label", () => {
    render(<SegmentedControl value="light" onChange={() => undefined} options={OPTIONS} label="Theme" />);
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    expect(group.querySelectorAll("button").length).toBe(3);
  });
});
