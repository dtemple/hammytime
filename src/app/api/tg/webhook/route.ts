import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { timingSafeEqual } from "crypto";
import { telegramBot } from "@/server/telegram/bot";

function verifySecret(header: string | null, expected: string): boolean {
  if (!header) return false;
  try {
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if ((process.env.TELEGRAM_BOT_MODE ?? "webhook") === "polling") {
    return new NextResponse("polling mode active — webhook endpoint disabled", {
      status: 503,
    });
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const header = req.headers.get("X-Telegram-Bot-Api-Secret-Token");

  if (!verifySecret(header, secret)) {
    return new NextResponse(null, { status: 401 });
  }

  const update = await req.json();

  try {
    const bot = telegramBot();
    await bot.init();
    await bot.handleUpdate(update);
  } catch (err) {
    Sentry.captureException(err);
  }

  return new NextResponse(null, { status: 200 });
}
