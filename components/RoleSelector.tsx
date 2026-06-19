"use client";

import type { RoleId } from "@/lib/types";
import { ROLE_LABEL } from "@/lib/types";

const ROLE_ICONS: Record<RoleId, string> = {
  0: "⬆",
  1: "🌿",
  2: "⚔",
  3: "🏹",
  4: "🛡",
  5: "★",
};

const ROLES: RoleId[] = [0, 1, 2, 3, 4];

interface RoleSelectorProps {
  value: RoleId;
  onChange: (role: RoleId) => void;
}

export default function RoleSelector({ value, onChange }: RoleSelectorProps) {
  return (
    <div className="flex gap-1.5 flex-wrap" role="group" aria-label="Select lane">
      {ROLES.map((role) => {
        const active = value === role; // highlight only the explicitly selected pill
        return (
          <button
            key={role}
            onClick={() => onChange(role)}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold transition-all border
              ${
                active
                  ? "bg-teal text-bg border-teal shadow-[0_0_8px_rgba(45,212,191,0.4)]"
                  : "bg-panel2 text-mut border-line hover:border-teal-dim hover:text-txt"
              }
            `}
            aria-pressed={active}
          >
            <span className="text-base leading-none">{ROLE_ICONS[role]}</span>
            <span>{ROLE_LABEL[role]}</span>
          </button>
        );
      })}
    </div>
  );
}
