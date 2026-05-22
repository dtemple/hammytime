import { execSync } from "child_process";
import { Bot, CommandContext, Context } from "grammy";
import { supabaseAdmin } from "@/lib/db";
import {
  handleOnboardingCallback,
  handleOnboardingMessage,
  onboardingSteps,
  resetOnboarding,
} from "./onboarding/index";

let _bot: Bot | null = null;

function getBuildInfo(): string | null {
  try {
    return execSync('git log -1 --format="%h — %s"').toString().trim();
  } catch {
    return null;
  }
}

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
    if (
      reason === "not_found" ||
      reason === "expired" ||
      reason === "already_used"
    ) {
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
    "Hi — I'm your training coach. We'll spend a few minutes getting you set up, then I'll give you a prompt to take to Claude or ChatGPT to build your training plan."
  );

  // Ask the first onboarding question
  const firstQuestion = onboardingSteps[0]?.questions[0];
  if (firstQuestion) {
    await sendAndLog(athleteId, ctx.chat.id, firstQuestion.prompt);
  }
}

async function handleRestart(ctx: CommandContext<Context>): Promise<void> {
  const db = supabaseAdmin();
  const { data: athlete, error } = await db
    .from("athletes")
    .select("id")
    .eq("telegram_chat_id", String(ctx.chat.id))
    .maybeSingle();

  if (error || !athlete) {
    await ctx.reply("No account linked to this chat.");
    return;
  }

  await resetOnboarding(athlete.id);

  await ctx.reply("Starting over from the beginning.");

  const build = getBuildInfo();
  if (build) await ctx.reply(`[build: ${build}]`);

  const firstQuestion = onboardingSteps[0]?.questions[0];
  if (firstQuestion) {
    await sendAndLog(athlete.id, ctx.chat.id, firstQuestion.prompt);
  }
}

async function handleInboundText(ctx: Context): Promise<void> {
  const db = supabaseAdmin();
  const { data: athlete, error } = await db
    .from("athletes")
    .select("*")
    .eq("telegram_chat_id", String(ctx.chat!.id))
    .maybeSingle();

  if (error || !athlete) {
    await ctx.reply("Use your invite link to get started.");
    return;
  }

  const state = athlete.onboarding_state as { step?: number } | null;
  const step = typeof state?.step === "number" ? state.step : 0;

  if (step < onboardingSteps.length) {
    await handleOnboardingMessage(ctx, athlete);
    return;
  }

  // Post-onboarding: route based on plan state
  const { data: plan } = await db
    .from("plans")
    .select("id")
    .eq("athlete_id", athlete.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!plan) {
    // Help path (no plan row created) or unexpected state
    await ctx.reply("Sit tight — David's on it. He'll be in touch.");
    return;
  }

  const { data: version } = await db
    .from("plan_versions")
    .select("status")
    .eq("plan_id", plan.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!version) {
    console.warn("[bot] athlete has a plan row but no plan_versions row", athlete.id);
    await ctx.reply("Your onboarding is complete — daily coaching is coming soon.");
    return;
  }

  if (version.status === "awaiting_paste") {
    const { data: pasteToken } = await db
      .from("link_tokens")
      .select("token")
      .eq("athlete_id", athlete.id)
      .eq("purpose", "plan_paste")
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (pasteToken) {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
      const pasteUrl = `${baseUrl}/p/${pasteToken.token}`;
      await ctx.reply(`Your paste link is still active: ${pasteUrl}\n\n(/restart to start over.)`);
    } else {
      await ctx.reply("Looks like your paste link expired or was used. /restart to get a new one.");
    }
  } else if (version.status === "active") {
    await ctx.reply("All set. Daily check-ins start when that side of the bot ships.");
  } else {
    await ctx.reply("Your onboarding is complete — daily coaching is coming soon.");
  }
}

function getBot(): Bot {
  if (!_bot) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    _bot = new Bot(token);
    _bot.command("ping", (ctx) => ctx.reply("pong"));
    _bot.command("start", handleStart);
    _bot.command("restart", handleRestart);
    _bot.on("message:text", async (ctx) => {
      if (!ctx.message.text.startsWith("/")) {
        await handleInboundText(ctx);
      }
    });
    _bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const db = supabaseAdmin();
      const { data: athlete } = await db
        .from("athletes")
        .select("*")
        .eq("telegram_chat_id", String(ctx.from.id))
        .maybeSingle();

      if (!athlete) {
        await ctx.answerCallbackQuery();
        return;
      }

      const state = athlete.onboarding_state as { step?: number } | null;
      const stepIdx = typeof state?.step === "number" ? state.step : 0;

      if (stepIdx >= onboardingSteps.length) {
        await ctx.answerCallbackQuery();
        return;
      }

      const step = onboardingSteps[stepIdx];
      if (!step?.handleCallback) {
        await ctx.answerCallbackQuery();
        return;
      }

      await handleOnboardingCallback(ctx, athlete, data);
    });
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
