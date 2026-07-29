import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { uploadBackingTrack } from "@/lib/clipper-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/backing-tracks — list all backing tracks
export async function GET() {
  const tracks = await db.backingTrack.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ tracks });
}

// POST /api/backing-tracks — upload a new backing track (multipart form)
// Form fields:
//   name: string  (label)
//   file: File    (mp3/wav/m4a)
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const name = String(formData.get("name") ?? "").trim();
    const file = formData.get("file");

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    // Validate file type — accept common audio formats
    const allowedTypes = [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/x-wav",
      "audio/m4a",
      "audio/x-m4a",
      "audio/aac",
      "audio/ogg",
    ];
    if (file.type && !allowedTypes.includes(file.type)) {
      // Allow if filename ends with .mp3/.wav/.m4a even if MIME is missing
      const lowerName = file.name.toLowerCase();
      if (!/\.(mp3|wav|m4a|aac|ogg)$/.test(lowerName)) {
        return NextResponse.json(
          { error: `unsupported file type: ${file.type || file.name}` },
          { status: 400 }
        );
      }
    }

    // Send to clipper for storage + duration probing
    const result = await uploadBackingTrack(name, file);

    // Persist in DB
    const track = await db.backingTrack.create({
      data: {
        id: result.id,
        name: result.name,
        storagePath: result.storagePath,
        fileSizeBytes: result.fileSizeBytes ?? file.size,
        durationSec: result.durationSec,
      },
    });

    return NextResponse.json({ track }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/backing-tracks]", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "internal error",
      },
      { status: 500 }
    );
  }
}
