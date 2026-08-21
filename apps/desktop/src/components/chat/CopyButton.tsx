import { useState } from "react";

/**
 * Copy-to-clipboard affordance for a chat message.
 *
 * The shell sets `user-select: none` on the body so the window feels like an app rather than a
 * web page, which also means a plain drag-select of a message doesn't work. Selection is restored
 * on message text (`.selectable`), and this button covers the common case in one click.
 *
 * Hidden until the message is hovered or the button is focused, so it never competes with the
 * conversation — but it stays keyboard reachable.
 */
export default function CopyButton({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older WKWebView builds reject the async clipboard API outside a user gesture chain;
      // the textarea fallback works everywhere and needs no permission.
      const staging = document.createElement("textarea");
      staging.value = text;
      staging.setAttribute("readonly", "");
      staging.style.position = "fixed";
      staging.style.opacity = "0";
      document.body.appendChild(staging);
      staging.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(staging);
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy message"}
      className={`shrink-0 rounded-md p-1 text-fg-dim opacity-0 transition hover:bg-white/5 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 ${className}`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
