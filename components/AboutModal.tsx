"use client";

import { useEffect, useState, type ReactNode } from "react";
import { XIcon } from "./Icons";

interface VersionSection {
  title: string;
  bullets: string[];
}

// Parses this repo's own CHANGELOG.md shape specifically (see that file) —
// not a general markdown parser. "## <version> — <date>" starts a new
// section, "- " lines within it are bullets, everything else (the top
// "# Changelog" line and its intro paragraph) is ignored.
function parseChangelog(markdown: string): VersionSection[] {
  const sections: VersionSection[] = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      sections.push({ title: line.slice(3).trim(), bullets: [] });
      continue;
    }
    if (line.startsWith("- ") && sections.length > 0) {
      sections[sections.length - 1].bullets.push(line.slice(2).trim());
    }
  }
  return sections;
}

const BOLD_PATTERN = /\*\*([^\n*]+?)\*\*/g;

function renderBold(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(BOLD_PATTERN);
  return parts.map((part, i) =>
    i % 2 === 1 ? <strong key={`${keyPrefix}-${i}`}>{part}</strong> : part
  );
}

export function AboutModal({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState<string | null>(null);
  const [sections, setSections] = useState<VersionSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/about")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Request failed"))))
      .then((data: { version: string; changelog: string }) => {
        if (cancelled) return;
        setVersion(data.version);
        setSections(parseChangelog(data.changelog));
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load the changelog.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-black/[0.06] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-zinc-900">About Hermes</h2>
            {version && <p className="mt-0.5 text-[12.5px] text-zinc-500">Version {version}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-600"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && <p className="text-[13px] text-red-600">{error}</p>}
          {!error && !sections && <p className="text-[13px] text-zinc-400">Loading…</p>}
          {sections?.map((section, i) => (
            <div key={section.title} className={i > 0 ? "mt-5" : ""}>
              <h3 className="text-[13.5px] font-semibold text-zinc-800">{section.title}</h3>
              <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 marker:text-zinc-300">
                {section.bullets.map((bullet, j) => (
                  <li key={j} className="text-[13px] leading-relaxed text-zinc-600">
                    {renderBold(bullet, `${i}-${j}`)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
