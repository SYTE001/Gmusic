import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Select } from "./Select";

describe("Select component", () => {
  const options = [
    { value: "title", label: "Title" },
    { value: "artist", label: "Artist" },
    { value: "dateAdded", label: "Date added" },
  ];

  it("renders trigger button with currently selected option label", () => {
    render(<Select value="dateAdded" onChange={vi.fn()} options={options} ariaLabel="Sort songs" />);
    const combobox = screen.getByRole("combobox", { name: "Sort songs" });
    expect(combobox.textContent).toContain("Date added");
    expect(combobox.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens listbox dropdown on click and displays options with checkmark on active", () => {
    render(<Select value="dateAdded" onChange={vi.fn()} options={options} ariaLabel="Sort songs" />);
    const combobox = screen.getByRole("combobox", { name: "Sort songs" });
    fireEvent.click(combobox);

    expect(combobox.getAttribute("aria-expanded")).toBe("true");
    const listbox = screen.getByRole("listbox", { name: "Sort songs" });
    expect(listbox).not.toBeNull();

    const optionElements = screen.getAllByRole("option");
    expect(optionElements).toHaveLength(3);

    const selectedOpt = optionElements.find((el) => el.getAttribute("aria-selected") === "true");
    expect(selectedOpt?.textContent).toContain("Date added");
  });

  it("calls onChange and closes dropdown when an option is clicked", () => {
    const onChange = vi.fn();
    render(<Select value="dateAdded" onChange={onChange} options={options} ariaLabel="Sort songs" />);
    
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: /Artist/i }));

    expect(onChange).toHaveBeenCalledWith("artist");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape key press", () => {
    render(<Select value="title" onChange={vi.fn()} options={options} ariaLabel="Sort songs" />);
    const combobox = screen.getByRole("combobox");
    fireEvent.click(combobox);
    expect(screen.getByRole("listbox")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("navigates options with ArrowDown and selects with Enter", () => {
    const onChange = vi.fn();
    render(<Select value="title" onChange={onChange} options={options} ariaLabel="Sort songs" />);
    const combobox = screen.getByRole("combobox");

    // Open with click
    fireEvent.click(combobox);
    // Arrow down from 0 (title) to 1 (artist)
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    // Press Enter to select
    fireEvent.keyDown(combobox, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("artist");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
