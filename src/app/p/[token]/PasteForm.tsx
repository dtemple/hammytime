"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type ApiError = {
  code?: string;
  message: string;
  location?: string;
};

export function PasteForm({ token }: { token: string }) {
  const router = useRouter();
  const [planJson, setPlanJson] = useState("");
  const [errors, setErrors] = useState<ApiError[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setSubmitting(true);

    try {
      const res = await fetch("/api/plans/paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, plan_json: planJson }),
      });

      const body = (await res.json()) as
        | { ok: true; summary: string }
        | { error: string; detail?: string; errors?: ApiError[] };

      if (res.ok) {
        router.push(`/p/${token}/done`);
        return;
      }

      if ("errors" in body && Array.isArray(body.errors)) {
        setErrors(body.errors as ApiError[]);
      } else if ("error" in body) {
        setErrors([
          {
            message:
              body.error === "json_parse_error"
                ? `Couldn't parse that as JSON: ${body.detail ?? "check for stray characters or incomplete output"}`
                : (body.error ?? "Something went wrong."),
          },
        ]);
      } else {
        setErrors([{ message: "Something went wrong." }]);
      }
    } catch {
      setErrors([{ message: "Network error — please try again." }]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {errors.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50 p-4 space-y-1">
          <p className="text-sm font-medium text-red-700">
            {errors.length === 1 ? "1 issue to fix:" : `${errors.length} issues to fix:`}
          </p>
          <ul className="list-disc pl-5 space-y-1">
            {errors.map((err, i) => (
              <li key={i} className="text-sm text-red-700">
                {err.location && (
                  <span className="font-mono text-xs text-red-500 mr-1">[{err.location}]</span>
                )}
                {err.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <label htmlFor="plan-json" className="text-sm font-medium text-gray-700">
          Paste your plan JSON here
        </label>
        <textarea
          id="plan-json"
          value={planJson}
          onChange={(e) => setPlanJson(e.target.value)}
          rows={20}
          className="w-full font-mono text-xs border border-gray-300 rounded p-3 resize-y focus:outline-none focus:ring-2 focus:ring-gray-400"
          placeholder='{"schema_version": 1, "meta": { ... }}'
          required
        />
      </div>

      <button
        type="submit"
        disabled={submitting || planJson.trim().length === 0}
        className="w-full py-2 px-4 rounded bg-gray-900 text-white text-sm font-medium hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? "Checking…" : "Submit plan"}
      </button>
    </form>
  );
}
