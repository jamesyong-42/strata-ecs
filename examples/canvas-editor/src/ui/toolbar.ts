/**
 * Toolbar — hand-rolled DOM, same actions as the keyboard map (input.ts holds the canonical
 * shortcut table; buttons here are the discoverable mirror).
 */

import { deleteSelection, duplicateSelection } from "../app/editorOps";
import { onToolChange, setTool, type ToolId } from "../app/tools";

const TOOLS: { id: ToolId; label: string; title: string }[] = [
  { id: "select", label: "◇", title: "Select / move (V)" },
  { id: "pan", label: "✋", title: "Pan (H, or hold Space)" },
  { id: "rect", label: "▭", title: "Rectangle (R)" },
  { id: "ellipse", label: "◯", title: "Ellipse (O)" },
  { id: "note", label: "🗒", title: "Sticky note (N)" },
];

export function buildToolbar(root: HTMLElement, notify: (msg: string) => void): void {
  const btn = (label: string, title: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    root.appendChild(b);
    return b;
  };

  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = btn(t.label, t.title);
    b.addEventListener("click", () => setTool(t.id));
    toolButtons.set(t.id, b);
  }
  onToolChange((active) => {
    for (const [id, b] of toolButtons) b.classList.toggle("active", id === active);
  });
  toolButtons.get("select")?.classList.add("active");

  const sep = document.createElement("span");
  sep.className = "sep";
  root.appendChild(sep);

  btn("⌫", "Delete selection (Del)").addEventListener("click", () => {
    const n = deleteSelection();
    if (n > 0) notify(`deleted ${n.toLocaleString()} shape${n === 1 ? "" : "s"} (arrows cascaded for free)`);
  });
  btn("⧉", "Duplicate selection (⌘D)").addEventListener("click", () => {
    const d = duplicateSelection();
    if (d.count > 0) notify(`duplicated ${d.count.toLocaleString()} shapes in ${d.ms.toFixed(1)}ms`);
  });
}
