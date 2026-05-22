"use client";

import { useState } from "react";

export function CopyableTemplate({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the textarea text
      const el = document.getElementById("prompt-textarea") as HTMLTextAreaElement | null;
      el?.select();
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-700">Your prompt</label>
        <button
          onClick={handleCopy}
          className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50 transition-colors"
        >
          {copied ? "Copied!" : "Copy prompt"}
        </button>
      </div>
      <textarea
        id="prompt-textarea"
        readOnly
        value={prompt}
        rows={28}
        className="w-full font-mono text-xs border border-gray-200 rounded p-3 bg-gray-50 resize-y focus:outline-none"
      />
    </div>
  );
}
