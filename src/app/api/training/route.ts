import { NextResponse } from "next/server";
import { exportTrainingData } from "@/lib/training";

/** Rebuilds storage/training/ and returns how much labelled data there is. */
export async function GET() {
  return NextResponse.json(await exportTrainingData());
}
