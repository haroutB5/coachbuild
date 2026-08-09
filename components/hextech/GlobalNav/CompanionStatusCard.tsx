"use client";

// Rail's live companion status card (v0.50.0, plan Decision 3). Thin wiring
// layer: reads useCompanion() (the single app-wide poll, CompanionProvider.tsx)
// and hands its real fields to the pure companionStatusModel — this component
// owns rendering only, never invents a state the model didn't return.
import Link from "next/link";
import { useCompanion } from "@/components/live/CompanionProvider";
import { companionStatusModel } from "./companionStatusModel";

export default function CompanionStatusCard() {
  const companion = useCompanion();
  const model = companionStatusModel({
    session: companion.session,
    phase: companion.phase,
    clientConnected: companion.clientConnected,
    champSelect: companion.champSelect,
    statusFresh: companion.statusFresh,
  });

  const genuinelyConnected = companion.statusFresh && companion.session !== null && companion.clientConnected;
  const genuinelyLive = genuinelyConnected && (companion.phase === "ChampSelect" || companion.phase === "InProgress");

  const body = (
    <div
      className="rounded-[8px] px-3 py-3 transition-colors duration-[120ms] ease-in"
      style={
        genuinelyConnected
          ? {
              background: "linear-gradient(150deg, rgba(70,199,155,.1), rgba(35,37,50,.9))",
              boxShadow: "inset 0 0 0 1px rgba(70,199,155,.24)",
            }
          : {
              background: "var(--panel-glass)",
              boxShadow: "inset 0 0 0 1px rgba(233,233,237,.07)",
            }
      }
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${genuinelyConnected ? "bg-good" : "bg-txt/20"} ${genuinelyLive ? "animate-pulse" : ""}`}
          aria-hidden="true"
        />
        <span className={`text-[9px] font-medium uppercase tracking-[0.14em] ${genuinelyConnected ? "text-good" : "text-txt/[0.38]"}`}>
          {model.header}
        </span>
      </div>
      <p className="text-[13px] font-semibold leading-tight text-txt">{model.title}</p>
      <p className="mt-0.5 text-[11px] leading-tight text-txt/[0.50]">{model.subtitle}</p>
    </div>
  );

  if (model.href) {
    return (
      <Link
        href={model.href}
        className="block rounded-lg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar"
      >
        {body}
      </Link>
    );
  }

  return body;
}
