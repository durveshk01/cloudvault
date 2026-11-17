"use client";

import { useEffect, useRef } from "react";

const dialogs: HTMLElement[] = [];
let previousOverflow = "";

/** Focus containment, Escape/Android-back dismissal and focus restoration. */
export function useDialog<T extends HTMLElement = HTMLDivElement>(isOpen: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const element = ref.current;
    if (!isOpen || !element) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (!dialogs.length) { previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
    dialogs.push(element);
    const focusable = () => Array.from(element.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
    )).filter((item) => item.getClientRects().length > 0);
    const target = element.querySelector<HTMLElement>("[data-autofocus]") || focusable()[0] || element;
    target.focus();
    const keydown = (event: KeyboardEvent) => {
      if (dialogs[dialogs.length - 1] !== element) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first) { event.preventDefault(); element.focus(); }
      else if (!element.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const back = (event: Event) => {
      if (dialogs[dialogs.length - 1] === element) { event.preventDefault(); close.current(); }
    };
    const focus = (event: FocusEvent) => {
      if (dialogs[dialogs.length - 1] === element && !element.contains(event.target as Node)) (focusable()[0] || element).focus();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("cv_native_back", back);
    document.addEventListener("focusin", focus);
    return () => {
      const index = dialogs.indexOf(element);
      const wasTop = index === dialogs.length - 1;
      if (index >= 0) dialogs.splice(index, 1);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("cv_native_back", back);
      document.removeEventListener("focusin", focus);
      if (!dialogs.length) document.body.style.overflow = previousOverflow;
      if (wasTop && previousFocus?.isConnected) previousFocus.focus();
    };
  }, [isOpen]);
  return ref;
}
