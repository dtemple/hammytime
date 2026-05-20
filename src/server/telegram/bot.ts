import { Bot, CommandContext, Context } from "grammy";
import { supabaseAdmin } from "@/lib/db";

let _bot: Bot | null = null;

// Sends a message and persists it to the messages table (direction = 'out').
export async function sendAndLog(
  athleteId: string,
  chatId: number | string,
  text: string
): Promise<void> {
  await getBot().api.sendMessage(chatId, text);
  await supabaseAdmin().from("messages").insert({
    athlete_id: athleteId,
    channel: "tg",
    direction: "out",
    body: text,
  });
}

async function handleStart(ctx: CommandContext<Context>): Promise<void> {
  const token = ctx.match?.trim();

  if (!token) {
    await ctx.reply(
      "To get started, grab your invite link from the signup page."
    );
    return;
  }

  const db = supabaseAdmin();
  const { data, error } = await db.rpc("link_start_handshake", {
    p_token: token,
    p_telegram_chat_id: String(ctx.chat.id),
  });

  if (error) {
    console.error("[/start] link_start_handshake error", error);
    await ctx.reply("Something went wrong on our end — ping David.");
    return;
  }

  if (!data.ok) {
    const reason = data.reason as string;
    if (reason === "not_found" || reason === "expired" || reason === "already_used") {
      await ctx.reply(
        "That link has expired or already been used. Head back to the signup page to get a fresh one."
      );
    } else {
      await ctx.reply("Something went wrong — ping David.");
    }
    return;
  }

  const athleteId = data.athlete_id as string;

  // Log the inbound /start message now that we have an athlete_id
  await db.from("messages").insert({
    athlete_id: athleteId,
    channel: "tg",
    direction: "in",
    body: `/start ${token}`,
  });

  await sendAndLog(
    athleteId,
    ctx.chat.id,
    "Hi — I'm your training coach. We'll spend a few minutes getting set up, then I'll give you a prompt to take to Claude or ChatGPT so you can build your plan. First — what's your name?"
  );
}

function getBot(): Bot {
  if (!_bot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    _bot = new Bot(token);
    _bot.command("ping", (ctx) => ctx.reply("pong"));
    _bot.command("start", handleStart);
    _bot.command("restart", (ctx) =>
      ctx.reply("Resetting onboarding isn't wired yet — ping David.")
    );
  }
  return _bot;
}

export function telegramBot(): Bot {
  return getBot();
}

export async function pingTelegram(): Promise<{ latency_ms: number }> {
  const start = Date.now();
  await getBot().api.getMe();
  return { latency_ms: Date.now() - start };
}
