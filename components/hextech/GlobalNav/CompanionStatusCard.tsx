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

  const body = (
    <div className="bg-panel2/60 border border-line rounded-lg px-3 py-2.5 transition-colors hover:border-line-gold">
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${model.dotClass}`} aria-hidden="true" />
        <span className="text-[9.5px] tracking-[0.1em] uppercase text-mut font-semibold">{model.header}</span>
      </div>
      <p className="text-[12px] font-medium text-txt leading-tight">{model.title}</p>
      <p className="text-[10.5px] text-mut leading-tight mt-0.5">{model.subtitle}</p>
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
