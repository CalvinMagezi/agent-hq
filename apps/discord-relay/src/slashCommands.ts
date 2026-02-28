import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import type { BaseHarness } from "./harnesses/base.js";
import type { VaultAPI as ConvexAPI } from "./vaultApi.js";
import type { RelayConfig } from "./types.js";
import type { ContextEnricher } from "./context.js";
import type { ThreadManager } from "@repo/discord-core";
import { getModelAliases } from "./commands.js";
import {
  buildSessionEmbed,
  buildUsageEmbed,
  buildMemoryEmbed,
  buildStatusEmbed,
  buildHelpEmbed,
  buildErrorEmbed,
} from "./embedBuilder.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface SlashCommandContext {
  harness: BaseHarness;
  config: RelayConfig;
  convex: ConvexAPI;
  enricher: ContextEnricher;
  threadManager?: ThreadManager;
}

interface SlashCommandDef {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction, ctx: SlashCommandContext) => Promise<void>;
}

// ── Command Definitions ───────────────────────────────────────────────

function defineCommands(harnessName: string): SlashCommandDef[] {
  const isGemini = harnessName === "Gemini CLI";
  const isOpenCode = harnessName === "OpenCode";
  const isClaude = !isGemini && !isOpenCode;

  const commands: SlashCommandDef[] = [];

  // /model — set or view current model
  commands.push({
    data: new SlashCommandBuilder()
      .setName("model")
      .setDescription("Set or view the active AI model")
      .addStringOption((opt) =>
        opt.setName("name").setDescription("Model name or alias").setAutocomplete(true),
      ) as SlashCommandBuilder,
    async execute(interaction, ctx) {
      const name = interaction.options.getString("name");
      const channelId = interaction.channelId;

      if (!name) {
        const current = ctx.harness.getChannelSettings(channelId).model;
        const aliases = Object.keys(getModelAliases(ctx.harness.harnessName)).join(", ");
        await interaction.reply({
          content: current
            ? `Current model: \`${current}\`\nAliases: ${aliases}`
            : `Using default model.\nAliases: ${aliases}`,
          ephemeral: true,
        });
        return;
      }

      const aliases = getModelAliases(ctx.harness.harnessName);
      const model = aliases[name.toLowerCase()] || name;
      await ctx.harness.setChannelSettings(channelId, { model });
      await interaction.reply(`Model set to \`${model}\`.`);
    },
  });

  // /reset — reset session and settings
  commands.push({
    data: new SlashCommandBuilder()
      .setName("reset")
      .setDescription("Reset session and settings to defaults"),
    async execute(interaction, ctx) {
      ctx.harness.kill(interaction.channelId);
      await ctx.harness.resetSession(interaction.channelId);
      await ctx.harness.clearChannelSettings(interaction.channelId);
      ctx.threadManager?.clearThread(interaction.channelId);
      await interaction.reply("Session and settings reset. Fresh start.");
    },
  });

  // /kill — force-stop running process
  commands.push({
    data: new SlashCommandBuilder()
      .setName("kill")
      .setDescription("Force-stop the running process in this channel"),
    async execute(interaction, ctx) {
      const killed = ctx.harness.kill(interaction.channelId);
      await interaction.reply(
        killed
          ? "Killed the running process."
          : "No active process to kill in this channel.",
      );
    },
  });

  // /session — show session info
  commands.push({
    data: new SlashCommandBuilder()
      .setName("session")
      .setDescription("Show current session info and settings"),
    async execute(interaction, ctx) {
      const session = ctx.harness.getSession(interaction.channelId);
      const settings = ctx.harness.getChannelSettings(interaction.channelId);
      await interaction.reply({
        embeds: [
          buildSessionEmbed(
            ctx.harness.harnessName,
            session.sessionId,
            settings,
            isGemini,
            isOpenCode,
          ),
        ],
      });
    },
  });

  // /usage — view session usage stats
  commands.push({
    data: new SlashCommandBuilder()
      .setName("usage")
      .setDescription("View session cost and usage stats")
      .addStringOption((opt) =>
        opt.setName("action").setDescription("Action").addChoices(
          { name: "View", value: "view" },
          { name: "Reset counters", value: "reset" },
        ),
      ) as SlashCommandBuilder,
    async execute(interaction, ctx) {
      const action = interaction.options.getString("action");
      if (action === "reset") {
        await ctx.harness.resetUsage();
        await interaction.reply("Usage counters reset.");
        return;
      }
      const usage = ctx.harness.getUsage();
      await interaction.reply({
        embeds: [buildUsageEmbed(usage, ctx.harness.harnessName)],
      });
    },
  });

  // /memory — view stored memories
  commands.push({
    data: new SlashCommandBuilder()
      .setName("memory")
      .setDescription("View stored facts and goals"),
    async execute(interaction, ctx) {
      const facts = await ctx.convex.getMemoryFacts();
      await interaction.reply({ embeds: [buildMemoryEmbed(facts)] });
    },
  });

  // /status — system health dashboard
  commands.push({
    data: new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show HQ system health dashboard"),
    async execute(interaction, ctx) {
      try {
        const status = await ctx.convex.getSystemStatus();
        await interaction.reply({ embeds: [buildStatusEmbed(status)] });
      } catch (err) {
        await interaction.reply({
          embeds: [buildErrorEmbed("Status Error", `${err}`)],
          ephemeral: true,
        });
      }
    },
  });

  // /help — command reference
  commands.push({
    data: new SlashCommandBuilder()
      .setName("help")
      .setDescription("Show available commands and usage"),
    async execute(interaction, ctx) {
      await interaction.reply({
        embeds: [buildHelpEmbed(ctx.harness.harnessName)],
        ephemeral: true,
      });
    },
  });

  // /clear — reset all channel settings
  commands.push({
    data: new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Reset all channel settings to defaults"),
    async execute(interaction, ctx) {
      await ctx.harness.clearChannelSettings(interaction.channelId);
      await interaction.reply("All channel settings cleared. Using defaults.");
    },
  });

  // /adddir — add directory access
  commands.push({
    data: new SlashCommandBuilder()
      .setName("adddir")
      .setDescription("Add a directory for the CLI tool to access")
      .addStringOption((opt) =>
        opt.setName("path").setDescription("Absolute path to directory").setRequired(true),
      ) as SlashCommandBuilder,
    async execute(interaction, ctx) {
      const dirPath = interaction.options.getString("path", true);
      const channelId = interaction.channelId;

      if (isOpenCode) {
        await ctx.harness.setChannelSettings(channelId, { addDirs: [dirPath] });
        await interaction.reply(`Working directory set to: \`${dirPath}\``);
      } else {
        const current = ctx.harness.getChannelSettings(channelId).addDirs || [];
        await ctx.harness.setChannelSettings(channelId, {
          addDirs: [...current, dirPath],
        });
        await interaction.reply(`Added directory: \`${dirPath}\``);
      }
    },
  });

  // /effort — set reasoning effort (Claude + OpenCode only)
  if (!isGemini) {
    commands.push({
      data: new SlashCommandBuilder()
        .setName("effort")
        .setDescription("Set reasoning effort level")
        .addStringOption((opt) =>
          opt.setName("level").setDescription("Effort level").setRequired(true).addChoices(
            { name: "Low", value: "low" },
            { name: "Medium", value: "medium" },
            { name: "High", value: "high" },
          ),
        ) as SlashCommandBuilder,
      async execute(interaction, ctx) {
        const level = interaction.options.getString("level", true) as "low" | "medium" | "high";
        await ctx.harness.setChannelSettings(interaction.channelId, { effort: level });
        const flag = isOpenCode ? "--variant" : "--effort";
        await interaction.reply(`Effort set to **${level}** (${flag}).`);
      },
    });
  }

  // /budget — set max spend (Claude only)
  if (isClaude) {
    commands.push({
      data: new SlashCommandBuilder()
        .setName("budget")
        .setDescription("Set max spend per call in USD")
        .addNumberOption((opt) =>
          opt.setName("amount").setDescription("Budget in USD (e.g. 0.50)").setRequired(true).setMinValue(0.01),
        ) as SlashCommandBuilder,
      async execute(interaction, ctx) {
        const amount = interaction.options.getNumber("amount", true);
        await ctx.harness.setChannelSettings(interaction.channelId, { maxBudget: amount });
        await interaction.reply(`Max budget set to **$${amount}** per call.`);
      },
    });
  }

  return commands;
}

// ── Registration & Dispatch ───────────────────────────────────────────

const commandCache = new Map<string, SlashCommandDef[]>();

export function getSlashCommandDefs(harnessName: string): SlashCommandDef[] {
  if (!commandCache.has(harnessName)) {
    commandCache.set(harnessName, defineCommands(harnessName));
  }
  return commandCache.get(harnessName)!;
}

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
  ctx: SlashCommandContext,
): Promise<void> {
  const defs = getSlashCommandDefs(ctx.harness.harnessName);
  const cmd = defs.find((d) => d.data.name === interaction.commandName);
  if (!cmd) {
    await interaction.reply({ content: "Unknown command.", ephemeral: true });
    return;
  }
  try {
    await cmd.execute(interaction, ctx);
  } catch (err: any) {
    console.error(`[SlashCmd] Error in /${interaction.commandName}:`, err.message);
    const reply = { embeds: [buildErrorEmbed("Command Error", err.message)], ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  harness: BaseHarness,
): Promise<void> {
  const focused = interaction.options.getFocused(true);

  if (interaction.commandName === "model" && focused.name === "name") {
    const aliases = getModelAliases(harness.harnessName);
    const query = focused.value.toLowerCase();
    const choices = Object.keys(aliases)
      .filter((name) => name.includes(query))
      .slice(0, 25)
      .map((name) => ({ name: `${name} → ${aliases[name]}`, value: name }));
    await interaction.respond(choices);
    return;
  }

  await interaction.respond([]);
}
