import { NextResponse } from "next/server";
import { getAllChampions } from "@/lib/staticData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const champions = await getAllChampions();
    return NextResponse.json(champions, {
      headers: {
        "Cache-Control": "s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch (err) {
    console.error("[/api/champions] Error:", err);
    return NextResponse.json(
      { error: "Failed to load champion list" },
      { status: 500 }
    );
  }
}
