"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computeDropdownPosition, type DropdownCoords } from "./dropdownPosition";

export interface ThemedSelectOption<T extends string | number> {
  value: T;
  label: string;
}

interface ThemedSelectProps<T extends string | number> {
  options: readonly ThemedSelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Extra classes for the closed trigger, not the portaled listbox. */
  triggerClassName?: string;
}

/**
 * A small, portal-backed select for dark surfaces where a native menu would
 * fall back to OS chrome. The trigger owns focus and the listbox is navigated
 * with the same arrow/Home/End/Enter/Escape contract as the champion pickers.
 */
export default function ThemedSelect<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  triggerClassName = "",
}: ThemedSelectProps<T>) {
  const rawId = useId();
  const idBase = rawId.replace(/:/g, "");
  const listboxId = `${idBase}-listbox`;
  const optionId = (index: number) => `${idBase}-option-${index}`;
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<DropdownCoords | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;

    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      // A select is commonly wrapped in a label. Clicking that label fires a
      // forwarded click on the trigger after this document mousedown; treat
      // the wrapper as inside so the outside close cannot immediately reopen
      // the already-open menu through the trigger toggle.
      if (containerRef.current?.closest("label")?.contains(target)) return;
      setOpen(false);
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }

    function measure() {
      const element = triggerRef.current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      setCoords(
        computeDropdownPosition(
          { top: rect.top, bottom: rect.bottom, left: rect.left },
          { width: window.innerWidth, height: window.innerHeight },
          rect.width
        )
      );
    }

    measure();
    function onScroll(event: Event) {
      if (dropdownRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }

    window.addEventListener("resize", measure);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (!options.length) {
      setActiveIndex(0);
    } else if (activeIndex >= options.length) {
      setActiveIndex(options.length - 1);
    }
  }, [activeIndex, options.length]);

  useEffect(() => {
    if (!open || !coords) return;
    listRef.current
      ?.querySelector(`[data-idx="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, coords, open]);

  function openList() {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function toggleList() {
    if (open) {
      setOpen(false);
      return;
    }
    openList();
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openList();
        return;
      }
      setActiveIndex((index) =>
        event.key === "ArrowDown"
          ? Math.min(index + 1, Math.max(options.length - 1, 0))
          : Math.max(index - 1, 0)
      );
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      if (!open) return;
      event.preventDefault();
      setActiveIndex(event.key === "Home" ? 0 : Math.max(options.length - 1, 0));
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        openList();
      } else {
        choose(activeIndex);
      }
      return;
    }

    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  }

  const selectedOption = options.find((option) => option.value === value);
  const activeOption = options[activeIndex];

  return (
    <div ref={containerRef} className="relative min-w-0 w-full">
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && activeOption ? optionId(activeIndex) : undefined}
        disabled={disabled}
        onClick={toggleList}
        onKeyDown={onTriggerKeyDown}
        className={`relative flex w-full items-center justify-between gap-2 rounded-md border border-line bg-panel2 px-2.5 py-2 text-left text-[11px] text-txt outline-none transition-colors motion-reduce:transition-none hover:border-teal-dim focus:border-teal focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-60 ${triggerClassName}`}
      >
        <span className="min-w-0 truncate">{selectedOption?.label ?? "Select an option"}</span>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 flex-shrink-0 text-mut" fill="none">
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
        </svg>
      </button>

      {open && mounted && coords && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed",
            top: coords.top,
            bottom: coords.bottom,
            left: coords.left,
            width: coords.width,
          }}
          className="z-50 overflow-hidden rounded-lg border border-line bg-panel shadow-[0_8px_32px_rgba(0,0,0,0.6)]"
        >
          <ul ref={listRef} id={listboxId} role="listbox" aria-label={ariaLabel} className="max-h-[260px] overflow-y-auto divide-y divide-line/40">
            {options.map((option, index) => {
              const active = index === activeIndex;
              return (
                <li
                  key={`${String(option.value)}-${index}`}
                  id={optionId(index)}
                  data-idx={index}
                  role="option"
                  aria-selected={option.value === value}
                  data-active={active || undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                  className={`cursor-pointer px-3 py-2.5 text-[12px] transition-colors motion-reduce:transition-none ${active ? "bg-teal/15" : "hover:bg-teal/10"} ${option.value === value ? "font-semibold text-teal" : "text-txt"}`}
                >
                  {option.label}
                </li>
              );
            })}
          </ul>
        </div>,
        document.body
      )}
    </div>
  );
}
