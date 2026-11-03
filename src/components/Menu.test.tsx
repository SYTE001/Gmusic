import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Menu, type MenuItemSpec } from "./Menu";

describe("Menu component", () => {
  const items: MenuItemSpec[] = [
    { kind: "heading", label: "Actions" },
    { kind: "action", label: "Play next", onSelect: vi.fn() },
    { kind: "separator" },
    { kind: "action", label: "Delete", danger: true, onSelect: vi.fn() },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders trigger button with accessibility attributes", () => {
    render(<Menu items={items} buttonLabel="Track options" />);
    const trigger = screen.getByRole("button", { name: "Track options" });
    expect(trigger).toBeDefined();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders dropdown into document.body portal on trigger click", () => {
    const { container } = render(<Menu items={items} buttonLabel="Track options" />);
    const trigger = screen.getByRole("button", { name: "Track options" });

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "Track options" });
    expect(menu).toBeDefined();

    // Verify it is portaled to document.body, not within container root
    expect(container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);

    // Verify fixed position and high z-index
    expect(menu.className).toContain("fixed");
    expect(menu.className).toContain("z-[100]");

    // Verify items
    expect(screen.getByText("Actions")).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Play next" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDefined();
  });

  it("calls item onSelect and closes menu when an action is clicked", () => {
    render(<Menu items={items} buttonLabel="Track options" />);
    fireEvent.click(screen.getByRole("button", { name: "Track options" }));

    const action = screen.getByRole("menuitem", { name: "Play next" });
    fireEvent.click(action);

    expect(items[1].kind === "action" && (items[1].onSelect as any)).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on click outside and calls onOpenChange", () => {
    const onOpenChange = vi.fn();
    render(
      <div>
        <div data-testid="outside">Outside area</div>
        <Menu items={items} buttonLabel="Track options" onOpenChange={onOpenChange} />
      </div>
    );

    fireEvent.click(screen.getByRole("button", { name: "Track options" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("menu")).toBeDefined();

    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape and restores focus to trigger", () => {
    render(<Menu items={items} buttonLabel="Track options" />);
    const trigger = screen.getByRole("button", { name: "Track options" });
    fireEvent.click(trigger);

    expect(screen.getByRole("menu")).toBeDefined();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("navigates between action items using ArrowDown and ArrowUp", () => {
    render(<Menu items={items} buttonLabel="Track options" />);
    fireEvent.click(screen.getByRole("button", { name: "Track options" }));

    const menu = screen.getByRole("menu");
    const actions = screen.getAllByRole("menuitem");
    expect(actions).toHaveLength(2);

    // Initial focus on first actionable item
    expect(document.activeElement).toBe(actions[0]);

    // ArrowDown moves to second action
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(actions[1]);

    // ArrowDown wraps back to first action
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(actions[0]);

    // ArrowUp moves to last action
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(actions[1]);
  });

  it("calculates auto-flip placement when near bottom of viewport", () => {
    const { unmount } = render(<Menu items={items} buttonLabel="Track options" />);
    const trigger = screen.getByRole("button", { name: "Track options" });

    // Mock getBoundingClientRect near bottom of viewport: e.g. top: 750, bottom: 780, window.innerHeight: 800
    // spaceBelow = 800 - 780 = 20 (< 280), spaceAbove = 750 (> 280) -> should flip to top
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      top: 750,
      bottom: 780,
      left: 1000,
      right: 1032,
      width: 32,
      height: 32,
      x: 1000,
      y: 750,
      toJSON: () => {},
    });

    fireEvent.click(trigger);

    const menu = screen.getByRole("menu");
    // Should be positioned with bottom style or data-placement="top"
    expect(menu.getAttribute("data-placement")).toBe("top");

    unmount();
  });
});
