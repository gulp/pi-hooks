import { randomUUID } from "crypto";
import {
	ActionRowBuilder,
	ActivityType,
	AttachmentBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	ChannelType,
	type ChatInputCommandInteraction,
	Client,
	EmbedBuilder,
	GatewayIntentBits,
	type Guild,
	type Message,
	MessageType,
	Partials,
	type PartialTextBasedChannelFields,
	ThreadAutoArchiveDuration,
	type ThreadChannel,
} from "discord.js";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { basename, join, resolve } from "path";
import type { DiscordProfileActivityType, DiscordProfileSettings, MomSettingsManager } from "../../context.js";
import * as log from "../../log.js";
import type {
	ChannelInfo,
	FormatterOutput,
	ToolResultData,
	ToolStartData,
	TransportContext,
	UsageSummaryData,
	UserInfo,
} from "../types.js";
import { DiscordChannelStore } from "./store.js";

const DISCORD_PRIMARY_MAX_CHARS = 2000;
const DISCORD_SECONDARY_MAX_CHARS = 2000;
const DISCORD_EMBED_TITLE_MAX_CHARS = 256;
const DISCORD_EMBED_ARGS_MAX_CHARS = 1000;
const DISCORD_EMBED_DESCRIPTION_MAX_CHARS = 3900;
const MAX_EVENT_QUEUE_SIZE = 5;

type QueuedWork = () => Promise<void>;

type PendingQuestion = {
	questionId: string;
	channelId: string;
	userId: string;
	prompt: string;
	options: string[];
	message: Message;
	timeout: NodeJS.Timeout;
	resolve: (value: { index: number; option: string }) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	abortListener?: () => void;
};

function buildQuestionActionRows(
	questionId: string,
	options: string[],
	params?: { disabled?: boolean; selectedIndex?: number },
): ActionRowBuilder<ButtonBuilder>[] {
	if (options.length < 2) {
		throw new Error("question options must have at least 2 items");
	}
	if (options.length > 25) {
		throw new Error("question options may not exceed 25 items");
	}

	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	let row = new ActionRowBuilder<ButtonBuilder>();

	for (let i = 0; i < options.length; i++) {
		const option = options[i]!;
		const label = option.length > 80 ? `${option.slice(0, 77)}...` : option;

		let style: ButtonStyle = ButtonStyle.Primary;
		if (params?.selectedIndex === i) {
			style = ButtonStyle.Success;
		}

		const button = new ButtonBuilder()
			.setCustomId(`mom-q-${questionId}-${i}`)
			.setLabel(label)
			.setStyle(style)
			.setDisabled(Boolean(params?.disabled));

		row.addComponents(button);

		if (row.components.length >= 5) {
			rows.push(row);
			row = new ActionRowBuilder<ButtonBuilder>();
		}
	}

	if (row.components.length > 0) {
		rows.push(row);
	}

	return rows;
}

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Discord queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

export interface MomDiscordHandler {
	onMention(ctx: TransportContext): Promise<void>;
	onDirectMessage(ctx: TransportContext): Promise<void>;
	onStopButton?(channelId: string): Promise<void>;
	onEvent?(ctx: TransportContext, isEvent: boolean): Promise<void>;
}

export interface MomDiscordConfig {
	botToken: string;
	workingDir: string;
	settingsManager?: MomSettingsManager;
}

export class MomDiscordBot {
	private client: Client;
	private handler: MomDiscordHandler;
	public readonly store: DiscordChannelStore;
	private botUserId: string | null = null;
	private userCache = new Map<string, { userName: string; displayName: string }>();
	private channelCache = new Map<string, string>();
	private queues = new Map<string, ChannelQueue>();
	private pendingQuestions = new Map<string, PendingQuestion>();
	private workingDir: string;
	private settingsManager?: MomSettingsManager;

	constructor(handler: MomDiscordHandler, config: MomDiscordConfig) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.settingsManager = config.settingsManager;
		this.client = new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildMessages,
				GatewayIntentBits.MessageContent,
				GatewayIntentBits.DirectMessages,
				GatewayIntentBits.GuildMembers,
				GatewayIntentBits.GuildMessageReactions,
			],
			partials: [Partials.Channel, Partials.Reaction],
		});
		this.store = new DiscordChannelStore({ workingDir: config.workingDir });

		this.setupEventHandlers(config);
	}

	private setupEventHandlers(config: MomDiscordConfig): void {
		this.client.on("ready", async () => {
			this.botUserId = this.client.user?.id || null;
			log.logInfo(`Discord: logged in as ${this.client.user?.tag}`);

			for (const [, guild] of this.client.guilds.cache) {
				await this.fetchGuildData(guild);
			}
			log.logInfo(`Discord: loaded ${this.channelCache.size} channels, ${this.userCache.size} users`);

			await this.backfillAllChannels();

			if (this.settingsManager) {
				const profile = this.settingsManager.getDiscordProfileSettings();
				if (Object.keys(profile).length > 0) {
					const result = await this.applyProfileUpdates(profile);
					if (!result.success) {
						log.logWarning("Discord profile apply failed", result.message);
					}
				}
			}
		});

		this.client.on("messageCreate", async (message: Message) => {
			if (message.author.bot) return;
			if (message.author.id === this.botUserId) return;
			if (!message.channel.isTextBased()) return;
			if (!this.isSendableTextChannel(message.channel)) return;

			const isDM = message.guild === null;
			const isMentioned = this.client.user ? message.mentions.has(this.client.user) : false;

			// Cache channel names on-the-fly (important for threads, which aren't included in guild.channels.fetch()).
			if (!isDM && "name" in message.channel) {
				const name = (message.channel as { name?: string }).name;
				if (name) {
					this.channelCache.set(message.channel.id, String(name));
				}
			}

			const attachments =
				message.attachments.size > 0
					? this.store.processAttachments(
							message.channel.id,
							Array.from(message.attachments.values()).flatMap((a) =>
								a.name && a.url ? [{ name: a.name, url: a.url }] : [],
							),
							message.id,
							message.guild?.id,
						)
					: [];

			const { userName, displayName } = await this.getUserInfo(message.author.id, message.guild || undefined);

			await this.store.logMessage(
				message.channel.id,
				{
					date: message.createdAt.toISOString(),
					ts: message.id,
					user: message.author.id,
					userName,
					displayName,
					text: message.content,
					attachments,
					isBot: false,
				},
				message.guild?.id,
			);

			if (isDM) {
				// Check DM authorization (silent reject if not allowed)
				if (!this.settingsManager?.canUserDM("discord", message.author.id)) {
					log.logWarning(
						`Discord: DM from ${message.author.id} (${userName}) blocked - DMs not authorized`,
						`To enable DMs, add "allowDMs": true to settings.json in ${this.workingDir}`,
					);
					return;
				}
				const ctx = await this.createContextFromMessage(
					message,
					attachments,
					userName,
					displayName,
					config.workingDir,
				);
				await this.handler.onDirectMessage(ctx);
			} else if (isMentioned) {
				const ctx = await this.createContextFromMessage(
					message,
					attachments,
					userName,
					displayName,
					config.workingDir,
				);
				await this.handler.onMention(ctx);
			}
		});

		this.client.on("guildCreate", async (guild: Guild) => {
			log.logInfo(`Discord: joined guild ${guild.name}`);
			await this.fetchGuildData(guild);
		});

		this.client.on("interactionCreate", async (interaction) => {
			if (!interaction.isButton()) return;

			if (interaction.customId.startsWith("mom-stop-")) {
				const channelId = interaction.customId.replace("mom-stop-", "");
				try {
					await interaction.deferUpdate();
				} catch (err) {
					// Interaction may have expired (Discord interactions expire after 3 seconds)
					// Error code 10062 = "Unknown interaction"
					const isExpired = err instanceof Error && "code" in err && (err as { code: number }).code === 10062;
					if (!isExpired) {
						log.logWarning(
							"Discord: Failed to defer button interaction",
							err instanceof Error ? err.message : String(err),
						);
					}
					// Continue with stop handler even if interaction expired
				}
				if (this.handler.onStopButton) {
					await this.handler.onStopButton(channelId);
				}
				return;
			}

			if (interaction.customId.startsWith("mom-q-")) {
				await this.handleQuestionButton(interaction);
			}
		});
	}

	private async handleQuestionButton(interaction: ButtonInteraction): Promise<void> {
		const match = /^mom-q-([a-zA-Z0-9]+)-(\d+)$/.exec(interaction.customId);
		if (!match) return;

		const questionId = match[1]!;
		const index = Number(match[2]!);

		const pending = this.pendingQuestions.get(questionId);
		if (!pending) {
			try {
				await interaction.reply({ content: "That question has expired.", ephemeral: true });
			} catch {
				// ignore
			}
			return;
		}

		if (!Number.isInteger(index) || index < 0 || index >= pending.options.length) {
			try {
				await interaction.reply({ content: "Invalid option.", ephemeral: true });
			} catch {
				// ignore
			}
			return;
		}

		if (interaction.user.id !== pending.userId) {
			try {
				await interaction.reply({
					content: `Only <@${pending.userId}> can answer this question.`,
					ephemeral: true,
				});
			} catch {
				// ignore
			}
			return;
		}

		this.pendingQuestions.delete(questionId);
		clearTimeout(pending.timeout);
		if (pending.signal && pending.abortListener) {
			pending.signal.removeEventListener("abort", pending.abortListener);
		}

		try {
			await interaction.deferUpdate();
		} catch (err) {
			// Interaction may have expired (Discord interactions expire after 3 seconds)
			// Error code 10062 = "Unknown interaction"
			const isExpired = err instanceof Error && "code" in err && (err as { code: number }).code === 10062;
			if (!isExpired) {
				log.logWarning(
					"Discord: Failed to defer question button interaction",
					err instanceof Error ? err.message : String(err),
				);
			}
		}

		const option = pending.options[index]!;
		try {
			await pending.message.edit({
				content: `${pending.prompt}\n\nSelected: **${option}**`,
				components: buildQuestionActionRows(questionId, pending.options, { disabled: true, selectedIndex: index }),
			});
		} catch {
			// ignore
		}

		pending.resolve({ index, option });
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	private getLogPath(channelId: string, guildId?: string): string {
		return guildId
			? join(this.workingDir, "discord", guildId, channelId, "log.jsonl")
			: join(this.workingDir, "discord", "dm", channelId, "log.jsonl");
	}

	private compareSnowflakes(a: string, b: string): number {
		try {
			const aa = BigInt(a);
			const bb = BigInt(b);
			if (aa < bb) return -1;
			if (aa > bb) return 1;
			return 0;
		} catch {
			return a.localeCompare(b);
		}
	}

	private isSnowflakeId(id: string): boolean {
		return /^[0-9]{16,22}$/.test(id);
	}

	private stripMentions(text: string): string {
		return text
			.replace(/<@!?\d+>/g, "")
			.replace(/[ \t]{2,}/g, " ")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n[ \t]+/g, "\n")
			.trim();
	}

	private getExistingTimestamps(channelId: string, guildId?: string): Set<string> {
		const logPath = this.getLogPath(channelId, guildId);
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as { ts?: string };
				if (entry.ts) timestamps.add(entry.ts);
			} catch {
				// ignore malformed line
			}
		}
		return timestamps;
	}

	private getBackfillTargetsFromDisk(): Array<{ channelId: string; guildId?: string; label: string }> {
		const discordDir = join(this.workingDir, "discord");
		if (!existsSync(discordDir)) return [];

		const targets: Array<{ channelId: string; guildId?: string; label: string }> = [];

		const rootEntries = readdirSync(discordDir, { withFileTypes: true });
		for (const entry of rootEntries) {
			if (!entry.isDirectory()) continue;

			if (entry.name === "dm") {
				const dmEntries = readdirSync(join(discordDir, entry.name), { withFileTypes: true });
				for (const dmChannelDir of dmEntries) {
					if (!dmChannelDir.isDirectory()) continue;
					const channelId = dmChannelDir.name;
					if (!this.isSnowflakeId(channelId)) continue;
					const logPath = join(discordDir, "dm", channelId, "log.jsonl");
					if (!existsSync(logPath)) continue;
					targets.push({ channelId, label: `dm-${channelId}` });
				}
				continue;
			}

			const guildId = entry.name;
			if (!this.isSnowflakeId(guildId)) continue;
			const guildDir = join(discordDir, guildId);
			const channelEntries = readdirSync(guildDir, { withFileTypes: true });
			for (const channelDir of channelEntries) {
				if (!channelDir.isDirectory()) continue;
				const channelId = channelDir.name;
				if (!this.isSnowflakeId(channelId)) continue;
				const logPath = join(guildDir, channelId, "log.jsonl");
				if (!existsSync(logPath)) continue;
				const channelName = this.channelCache.get(channelId);
				targets.push({ channelId, guildId, label: channelName || channelId });
			}
		}

		return targets;
	}

	private async backfillChannel(channelId: string, guildId?: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId, guildId);

		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || this.compareSnowflakes(ts, latestTs) > 0) {
				latestTs = ts;
			}
		}
		if (!latestTs) return 0;

		const channel = await this.client.channels.fetch(channelId).catch(() => null);
		if (!channel) return 0;
		if (!channel.isTextBased()) return 0;

		const allMessages: Message[] = [];

		let after = latestTs;
		let pageCount = 0;
		const maxPages = 3;

		while (pageCount < maxPages) {
			const fetched = await channel.messages.fetch({ after, limit: 100 });
			if (fetched.size === 0) break;

			const batch = Array.from(fetched.values());
			allMessages.push(...batch);

			let maxId: string | undefined;
			for (const msg of batch) {
				if (!maxId || this.compareSnowflakes(msg.id, maxId) > 0) {
					maxId = msg.id;
				}
			}

			if (!maxId || maxId === after) break;
			after = maxId;
			pageCount++;
		}

		const seen = new Set<string>();
		const relevantMessages = allMessages.filter((msg) => {
			if (seen.has(msg.id)) return false;
			seen.add(msg.id);

			if (msg.system) return false;
			if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) return false;
			if (existingTs.has(msg.id)) return false;

			if (!msg.author) return false;
			const isMomMessage = msg.author.id === this.botUserId && msg.author.bot;
			if (msg.author?.bot && !isMomMessage) return false;
			if (!msg.content && msg.attachments.size === 0) return false;

			return true;
		});

		relevantMessages.sort((a, b) => this.compareSnowflakes(a.id, b.id));

		for (const msg of relevantMessages) {
			const isMomMessage = msg.author.id === this.botUserId;
			const text = this.stripMentions(msg.content || "");

			const attachments =
				msg.attachments.size > 0
					? this.store.processAttachments(
							channelId,
							Array.from(msg.attachments.values()).flatMap((a) =>
								a.name && a.url ? [{ name: a.name, url: a.url }] : [],
							),
							msg.id,
							guildId,
						)
					: [];

			if (isMomMessage) {
				await this.store.logMessage(
					channelId,
					{
						date: msg.createdAt.toISOString(),
						ts: msg.id,
						user: "bot",
						text,
						attachments,
						isBot: true,
					},
					guildId,
				);
			} else {
				const { userName, displayName } = await this.getUserInfo(msg.author.id, msg.guild || undefined);
				await this.store.logMessage(
					channelId,
					{
						date: msg.createdAt.toISOString(),
						ts: msg.id,
						user: msg.author.id,
						userName,
						displayName,
						text,
						attachments,
						isBot: false,
					},
					guildId,
				);
			}

			existingTs.add(msg.id);
		}

		return relevantMessages.length;
	}

	private async backfillAllChannels(): Promise<void> {
		if (!this.botUserId) {
			log.logWarning("Discord backfill skipped", "bot user id not available");
			return;
		}

		const startTime = Date.now();

		const targets = this.getBackfillTargetsFromDisk();
		log.logBackfillStart(targets.length);

		let totalMessages = 0;
		for (const target of targets) {
			try {
				const count = await this.backfillChannel(target.channelId, target.guildId);
				if (count > 0) log.logBackfillChannel(target.label, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(
					`Failed to backfill ${target.guildId ? `${target.guildId}/${target.channelId}` : `dm/${target.channelId}`}`,
					String(error),
				);
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	private async fetchGuildData(guild: Guild): Promise<void> {
		try {
			const channels = await guild.channels.fetch();
			for (const [id, channel] of channels) {
				if (!channel) continue;
				if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildForum) {
					this.channelCache.set(id, channel.name);
				}
			}

			const members = await guild.members.fetch({ limit: 1000 });
			for (const [id, member] of members) {
				this.userCache.set(id, {
					userName: member.user.username,
					displayName: member.displayName || member.user.username,
				});
			}
		} catch (error) {
			log.logWarning("Discord: failed to fetch guild metadata", `${guild.name}: ${String(error)}`);
		}
	}

	getChannels(): ChannelInfo[] {
		return Array.from(this.channelCache.entries()).map(([id, name]) => ({ id, name }));
	}

	getUsers(): UserInfo[] {
		return Array.from(this.userCache.entries()).map(([id, { userName, displayName }]) => ({
			id,
			userName,
			displayName,
		}));
	}

	private async getUserInfo(userId: string, guild?: Guild): Promise<{ userName: string; displayName: string }> {
		const cached = this.userCache.get(userId);
		if (cached) return cached;

		try {
			if (guild) {
				const member = await guild.members.fetch(userId);
				const info = {
					userName: member.user.username,
					displayName: member.displayName || member.user.username,
				};
				this.userCache.set(userId, info);
				return info;
			}

			const user = await this.client.users.fetch(userId);
			const info = {
				userName: user.username,
				displayName: user.displayName || user.username,
			};
			this.userCache.set(userId, info);
			return info;
		} catch {
			const fallback = { userName: userId, displayName: userId };
			this.userCache.set(userId, fallback);
			return fallback;
		}
	}

	private isSendableTextChannel(channel: unknown): channel is PartialTextBasedChannelFields<boolean> {
		if (typeof channel !== "object" || channel === null) return false;
		const maybeSend = (channel as { send?: unknown }).send;
		if (typeof maybeSend !== "function") return false;
		return true;
	}

	private splitMessage(text: string, maxLen: number): string[] {
		if (text.length <= maxLen) return [text];

		const parts: string[] = [];
		let remaining = text;
		while (remaining.length > 0) {
			let cut = Math.min(maxLen, remaining.length);
			const newlineCut = remaining.lastIndexOf("\n", cut);
			if (newlineCut > Math.floor(maxLen * 0.6)) cut = newlineCut;
			const head = remaining.slice(0, cut).trimEnd();
			parts.push(head.length > 0 ? head : remaining.slice(0, Math.min(maxLen, remaining.length)));
			remaining = remaining.slice(cut);
			if (remaining.startsWith("\n")) remaining = remaining.slice(1);
		}
		return parts;
	}

	private createDiscordContext(params: {
		workingDir: string;
		channelDir: string;
		channelName?: string;
		guildId?: string;
		guildName?: string;
		message: TransportContext["message"];

		sendTyping?: () => Promise<void>;
		postPrimary: (payload: { content: string; components: ActionRowBuilder<ButtonBuilder>[] }) => Promise<Message>;
		postText: (content: string) => Promise<Message>;
		postEmbed: (embed: EmbedBuilder) => Promise<Message>;
		uploadFile: (filePath: string, title?: string) => Promise<void>;
	}): TransportContext {
		let statusMessage: Message | null = null; // Shows current status (e.g., "→ Running bash")

		let finalResponseMessage: Message | null = null; // The actual response
		const responseOverflowMessages: Message[] = []; // Overflow messages for long responses
		const emptyComponents: ActionRowBuilder<ButtonBuilder>[] = []; // Status message has no components

		// `secondaryMessages` are "append-only" auxiliary messages (tool results, usage summary, etc.)
		const secondaryMessages: Message[] = [];

		// Track tool result messages with their full embed data for collapse/expand
		const toolResultMessages: Array<{ message: Message; fullEmbed: EmbedBuilder; collapsedEmbed: EmbedBuilder }> = [];

		// Track usage summary for posting after final response
		let usageSummaryMessage: Message | null = null;
		let bufferedUsageSummaryEmbed: EmbedBuilder | null = null;

		// Thread for tool results (created lazily)
		let toolThread: ThreadChannel | null = null;

		// Buffer for accumulating status text during the run
		let statusText = "";
		let isWorking = true;
		const workingIndicator = " ...";

		// Buffer for the final response (posted at the end)
		let bufferedFinalResponse = "";

		// Promise chain to serialize all Discord API operations (like Slack does)
		let updatePromise = Promise.resolve();

		const formatting = {
			italic: (t: string) => `*${t}*`,
			bold: (t: string) => `**${t}**`,
			code: (t: string) => `\`${t}\``,
			codeBlock: (t: string) => `\`\`\`\n${t}\n\`\`\``,
		};

		const getOrCreateThread = async (): Promise<ThreadChannel | null> => {
			if (toolThread) return toolThread;
			if (!statusMessage) return null;
			if (!statusMessage.channel || statusMessage.channel.type === ChannelType.DM) return null;
			try {
				toolThread = await statusMessage.startThread({
					name: "Details",
					autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
				});
				return toolThread;
			} catch (err) {
				log.logWarning("Failed to create thread for details", err instanceof Error ? err.message : String(err));
				return null;
			}
		};

		// Track whether stop button is currently shown
		let hasStopButton = false;

		const editOrSendStatus = async (content: string): Promise<Message> => {
			const components = hasStopButton ? [buildStopButton()] : emptyComponents;
			if (statusMessage) {
				await statusMessage.edit({ content, components });
				return statusMessage;
			}
			const posted = await params.postPrimary({ content, components });
			statusMessage = posted;
			return posted;
		};

		const sendSecondary = async (content: string): Promise<void> => {
			const parts = this.splitMessage(content, DISCORD_SECONDARY_MAX_CHARS);
			const thread = await getOrCreateThread();
			for (const part of parts) {
				if (thread) {
					const msg = await thread.send(part);
					secondaryMessages.push(msg);
				} else {
					const msg = await params.postText(part);
					secondaryMessages.push(msg);
				}
			}
		};

		// Tool result visibility settings
		// - showToolResultsEnabled controls whether tool results are posted at all.
		// - showToolResultsExpanded controls whether we include full args/results (vs a collapsed title-only view).
		const collapseOnComplete = this.settingsManager?.collapseDetailsOnComplete ?? false;
		const showToolResultsEnabled = this.settingsManager?.showToolResults ?? true;
		const showToolResultsExpanded = showToolResultsEnabled && !collapseOnComplete;

		const buildStopButton = (): ActionRowBuilder<ButtonBuilder> => {
			const stopButton = new ButtonBuilder()
				.setCustomId(`mom-stop-${params.message.channelId}`)
				.setLabel("Stop")
				.setStyle(ButtonStyle.Danger);
			return new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);
		};

		const postFinalResponseMessage = async (content: string): Promise<void> => {
			// Delete old response messages
			if (finalResponseMessage) {
				try {
					await finalResponseMessage.delete();
				} catch {
					// ignore
				}
				finalResponseMessage = null;
			}
			for (const msg of responseOverflowMessages) {
				try {
					await msg.delete();
				} catch {
					// ignore
				}
			}
			responseOverflowMessages.length = 0;

			if (!content.trim()) return;

			// Split content if too long
			const parts = this.splitMessage(content, DISCORD_PRIMARY_MAX_CHARS);
			if (parts.length === 0) return;

			// Post all parts
			for (let i = 0; i < parts.length; i++) {
				const msg = await params.postText(parts[i]);
				if (i === 0) {
					finalResponseMessage = msg;
				} else {
					responseOverflowMessages.push(msg);
				}
			}
		};

		const addStopButton = async (): Promise<void> => {
			hasStopButton = true;
			const row = buildStopButton();
			if (statusMessage) {
				try {
					await statusMessage.edit({ content: statusMessage.content, components: [row] });
				} catch {
					// ignore
				}
			} else {
				statusMessage = await params.postPrimary({ content: "-# *Thinking...*", components: [row] });
			}
		};

		const removeStopButton = async (): Promise<void> => {
			hasStopButton = false;
			if (statusMessage) {
				try {
					await statusMessage.edit({ content: statusMessage.content, components: [] });
				} catch {
					// ignore
				}
			}
		};

		// Map of toolCallId -> { message, entry in toolResultMessages }
		const pendingToolMessages = new Map<string, { message: Message; index: number }>();

		const startToolResult = async (data: ToolStartData): Promise<void> => {
			const rawTitle = `⏳ ${data.toolName}${data.label ? `: ${data.label}` : ""}`;
			const title =
				rawTitle.length > DISCORD_EMBED_TITLE_MAX_CHARS
					? `${rawTitle.slice(0, DISCORD_EMBED_TITLE_MAX_CHARS - 3)}...`
					: rawTitle;

			// Initial "running" embed - show collapsed version if collapseOnComplete is enabled
			const runningEmbed = new EmbedBuilder().setTitle(title).setColor(0x808080); // Gray for running

			if (showToolResultsExpanded && data.args?.trim()) {
				const truncatedArgs =
					data.args.length > DISCORD_EMBED_ARGS_MAX_CHARS
						? `${data.args.slice(0, DISCORD_EMBED_ARGS_MAX_CHARS - 3)}...`
						: data.args;
				runningEmbed.addFields({ name: "Arguments", value: `\`\`\`\n${truncatedArgs}\n\`\`\``, inline: false });
				runningEmbed.setDescription("*Running...*");
			}
			// When collapsed, just show title (no args, no description)

			const thread = await getOrCreateThread();
			let msg: Message;
			if (thread) {
				msg = await thread.send({ embeds: [runningEmbed] });
			} else {
				msg = await params.postEmbed(runningEmbed);
			}
			secondaryMessages.push(msg);

			// Create placeholder entries - will be updated when tool completes
			const placeholderFull = new EmbedBuilder();
			const placeholderCollapsed = new EmbedBuilder();
			const index = toolResultMessages.length;
			toolResultMessages.push({ message: msg, fullEmbed: placeholderFull, collapsedEmbed: placeholderCollapsed });
			pendingToolMessages.set(data.toolCallId, { message: msg, index });
		};

		const sendToolResult = async (data: ToolResultData): Promise<void> => {
			const titlePrefix = data.isError ? "ERR" : "OK";
			const rawTitle = `${titlePrefix} ${data.toolName}${data.label ? `: ${data.label}` : ""}`;
			const title =
				rawTitle.length > DISCORD_EMBED_TITLE_MAX_CHARS
					? `${rawTitle.slice(0, DISCORD_EMBED_TITLE_MAX_CHARS - 3)}...`
					: rawTitle;

			// Full embed with all details
			const fullEmbed = new EmbedBuilder()
				.setTitle(title)
				.setColor(data.isError ? 0xff0000 : 0x00ff00)
				.setFooter({ text: `Duration: ${data.durationSecs}s` });

			if (data.args?.trim()) {
				const truncatedArgs =
					data.args.length > DISCORD_EMBED_ARGS_MAX_CHARS
						? `${data.args.slice(0, DISCORD_EMBED_ARGS_MAX_CHARS - 3)}...`
						: data.args;
				fullEmbed.addFields({ name: "Arguments", value: `\`\`\`\n${truncatedArgs}\n\`\`\``, inline: false });
			}

			const truncatedResult =
				data.result.length > DISCORD_EMBED_DESCRIPTION_MAX_CHARS
					? `${data.result.slice(0, DISCORD_EMBED_DESCRIPTION_MAX_CHARS - 3)}...`
					: data.result;
			fullEmbed.setDescription(`\`\`\`\n${truncatedResult}\n\`\`\``);

			// Collapsed embed with just title and duration
			const collapsedEmbed = new EmbedBuilder()
				.setTitle(title)
				.setColor(data.isError ? 0xff0000 : 0x00ff00)
				.setFooter({ text: `Duration: ${data.durationSecs}s` });

			// Choose which embed to show based on current state
			const embedToShow = showToolResultsExpanded ? fullEmbed : collapsedEmbed;

			// Check if we have a pending message to update
			const pending = pendingToolMessages.get(data.toolCallId);
			if (pending) {
				// Update the existing message
				try {
					await pending.message.edit({ embeds: [embedToShow] });
					// Update the stored embeds for toggle functionality
					toolResultMessages[pending.index] = {
						message: pending.message,
						fullEmbed,
						collapsedEmbed,
					};
				} catch (err) {
					log.logWarning("Failed to update tool result embed", err instanceof Error ? err.message : String(err));
				}
				pendingToolMessages.delete(data.toolCallId);
			} else {
				// No pending message (startToolResult wasn't called), post new message
				const thread = await getOrCreateThread();
				let msg: Message;
				if (thread) {
					msg = await thread.send({ embeds: [embedToShow] });
				} else {
					msg = await params.postEmbed(embedToShow);
				}
				secondaryMessages.push(msg);
				toolResultMessages.push({ message: msg, fullEmbed, collapsedEmbed });
			}
		};

		const sendUsageSummary = async (data: UsageSummaryData, formatterOutput?: FormatterOutput): Promise<void> => {
			const formatNum = (n: number) => n.toLocaleString();
			const formatCost = (n: number) => `$${n.toFixed(4)}`;

			if (formatterOutput) {
				const fullEmbed = new EmbedBuilder()
					.setColor(formatterOutput.color ?? 0x2b2d31)
					.setAuthor({ name: formatterOutput.title ?? "Usage Summary" });

				if (formatterOutput.fields) {
					for (const field of formatterOutput.fields) {
						fullEmbed.addFields({ name: field.name, value: field.value, inline: field.inline ?? true });
					}
				}

				if (formatterOutput.footer) {
					fullEmbed.setFooter({ text: formatterOutput.footer });
				}

				// Collapsed version - just the title
				const collapsedEmbed = new EmbedBuilder()
					.setColor(formatterOutput.color ?? 0x2b2d31)
					.setAuthor({ name: formatterOutput.title ?? "Usage Summary" });

				// Buffer for posting after final response
				bufferedUsageSummaryEmbed = showToolResultsExpanded ? fullEmbed : collapsedEmbed;
				return;
			}

			const fullEmbed = new EmbedBuilder().setColor(0x2b2d31).setAuthor({ name: "Usage Summary" });

			fullEmbed.addFields({
				name: "Tokens",
				value: `\`${formatNum(data.tokens.input)}\` in  \`${formatNum(data.tokens.output)}\` out`,
				inline: true,
			});

			fullEmbed.addFields({
				name: "Context",
				value: `\`${data.context.percent}\` of ${formatNum(data.context.max)}`,
				inline: true,
			});

			fullEmbed.addFields({
				name: "Cost",
				value: `**${formatCost(data.cost.total)}**`,
				inline: true,
			});

			if (data.cache.read > 0 || data.cache.write > 0) {
				fullEmbed.addFields({
					name: "Cache",
					value: `\`${formatNum(data.cache.read)}\` read  \`${formatNum(data.cache.write)}\` write`,
					inline: true,
				});
			}

			fullEmbed.setFooter({
				text: `In: ${formatCost(data.cost.input)} | Out: ${formatCost(data.cost.output)} | Cache read: ${formatCost(data.cost.cacheRead)} | Cache write: ${formatCost(data.cost.cacheWrite)}`,
			});

			// Collapsed version - just shows cost
			const collapsedEmbed = new EmbedBuilder()
				.setColor(0x2b2d31)
				.setAuthor({ name: `Usage: ${formatCost(data.cost.total)}` });

			// Buffer for posting after final response
			const embedToShow = showToolResultsExpanded ? fullEmbed : collapsedEmbed;
			bufferedUsageSummaryEmbed = embedToShow;
		};

		const ctx: TransportContext = {
			transport: "discord",
			workingDir: params.workingDir,
			channelDir: params.channelDir,
			channelName: params.channelName,
			guildId: params.guildId,
			guildName: params.guildName,
			message: params.message,
			channels: this.getChannels(),
			users: this.getUsers(),
			formatting,
			limits: { responseMaxChars: DISCORD_PRIMARY_MAX_CHARS, detailsMaxChars: DISCORD_SECONDARY_MAX_CHARS },
			duplicateResponseToDetails: false,
			showDetails: this.settingsManager?.showDetails ?? true,
			get showToolResults() {
				return showToolResultsEnabled;
			},

			send: async (target, content, opts) => {
				const _shouldLog = opts?.log ?? true;
				updatePromise = updatePromise.then(async () => {
					if (target === "details") {
						await sendSecondary(content);
						return;
					}

					// During the run, update the status message with tool labels etc.
					// Buffer the actual response text for posting at the end
					if (
						content.startsWith("*→") ||
						content.startsWith("*Error:") ||
						content.startsWith("*Compacting") ||
						content.startsWith("*Retrying")
					) {
						// This is a status update (tool label, error, etc.) - show in status message
						statusText = statusText ? `${statusText}\n${content}` : content;
						const displayText = isWorking ? statusText + workingIndicator : statusText;
						await editOrSendStatus(displayText);
					} else {
						// This is actual response content - buffer it for later
						bufferedFinalResponse = bufferedFinalResponse ? `${bufferedFinalResponse}\n${content}` : content;
						// Don't log yet - will log when posting final response
					}
				});
				await updatePromise;
			},

			replaceResponse: async (content) => {
				updatePromise = updatePromise.then(async () => {
					bufferedFinalResponse = content;
				});
				await updatePromise;
			},

			setTyping: async (isTyping) => {
				if (!isTyping) return;
				updatePromise = updatePromise.then(async () => {
					if (params.sendTyping) {
						await params.sendTyping();
					}
					if (!statusMessage) {
						statusText = "-# *Thinking...*";
						await editOrSendStatus(statusText + workingIndicator);
					}
				});
				await updatePromise;
			},

			uploadFile: async (filePath, title) => {
				updatePromise = updatePromise.then(async () => {
					await params.uploadFile(filePath, title);
				});
				await updatePromise;
			},

			setWorking: async (working) => {
				updatePromise = updatePromise.then(async () => {
					isWorking = working;
					if (statusMessage) {
						const displayText = isWorking ? statusText + workingIndicator : statusText;
						await statusMessage.edit({ content: displayText, components: emptyComponents });
					}
				});
				await updatePromise;
			},

			deleteResponseAndDetails: async () => {
				updatePromise = updatePromise.then(async () => {
					// Delete final response message
					if (finalResponseMessage) {
						try {
							await finalResponseMessage.delete();
						} catch {
							// ignore
						}
						finalResponseMessage = null;
					}

					// Delete response overflow messages
					for (const msg of responseOverflowMessages) {
						try {
							await msg.delete();
						} catch {
							// ignore
						}
					}
					responseOverflowMessages.length = 0;

					// Delete thread (this also deletes messages inside it)
					if (toolThread) {
						try {
							await toolThread.delete();
						} catch {
							// ignore
						}
						toolThread = null;
					}
					secondaryMessages.length = 0;
					toolResultMessages.length = 0;
					usageSummaryMessage = null;
					bufferedUsageSummaryEmbed = null;

					// Delete status message
					if (statusMessage) {
						try {
							await statusMessage.delete();
						} catch {
							// ignore
						}
						statusMessage = null;
					}

					// Clear buffers
					statusText = "";
					bufferedFinalResponse = "";
				});
				await updatePromise;
			},

			startToolResult: async (data) => {
				updatePromise = updatePromise.then(() => startToolResult(data));
				await updatePromise;
			},
			sendToolResult: async (data) => {
				updatePromise = updatePromise.then(() => sendToolResult(data));
				await updatePromise;
			},
			sendUsageSummary: async (data, formatterOutput) => {
				updatePromise = updatePromise.then(() => sendUsageSummary(data, formatterOutput));
				await updatePromise;
			},
			addStopControl: async () => {
				updatePromise = updatePromise.then(() => addStopButton());
				await updatePromise;
			},
			removeStopControl: async () => {
				updatePromise = updatePromise.then(() => removeStopButton());
				await updatePromise;
			},

			// Post the buffered final response (called after usage summary)
			postFinalResponse: async () => {
				updatePromise = updatePromise.then(async () => {
					// Delete the status message since we're done
					if (statusMessage) {
						try {
							await statusMessage.delete();
						} catch {
							// ignore
						}
						statusMessage = null;
					}

					// Post the final response
					if (bufferedFinalResponse.trim()) {
						await postFinalResponseMessage(bufferedFinalResponse);
						// Log the response
						if (finalResponseMessage) {
							await this.store.logBotResponse(
								params.message.channelId,
								bufferedFinalResponse,
								finalResponseMessage.id,
								params.guildId,
							);
						}
					}

					// Post usage summary after the final response
					if (bufferedUsageSummaryEmbed) {
						usageSummaryMessage = await params.postEmbed(bufferedUsageSummaryEmbed);
						secondaryMessages.push(usageSummaryMessage);
					}
				});
				await updatePromise;
			},

			// Get the buffered response (for checking [SILENT] etc.)
			getBufferedResponse: () => bufferedFinalResponse,
		};

		return ctx;
	}

	private async createContextFromMessage(
		message: Message,
		attachments: Array<{ local: string }>,
		userName: string,
		displayName: string,
		workingDir: string,
	): Promise<TransportContext> {
		const rawText = message.content;
		// Remove only the bot mention, keep other user mentions intact.
		// Fallback to stripping all mentions if botUserId isn't available for some reason.
		const mentionPattern = this.botUserId ? new RegExp(`<@!?${this.botUserId}>`, "g") : /<@!?\d+>/g;
		const text = rawText.replace(mentionPattern, "").trim();

		const channelName =
			message.channel.type === ChannelType.DM
				? undefined
				: "name" in message.channel
					? String((message.channel as { name?: string }).name)
					: undefined;

		const guildId = message.guild?.id;
		const guildName = message.guild?.name;

		const channelDir = this.store.getChannelDir(message.channel.id, guildId);

		const channel = message.channel;
		if (!this.isSendableTextChannel(channel)) {
			throw new Error(`Unsupported Discord channel type for sending messages (channelId=${message.channel.id})`);
		}

		const reactions = message.reactions.cache.map((r) => ({
			emoji: r.emoji.name || r.emoji.toString(),
			count: r.count,
		}));

		return this.createDiscordContext({
			workingDir,
			channelDir,
			channelName,
			guildId,
			guildName,
			message: {
				text,
				rawText,
				userId: message.author.id,
				userName,
				displayName,
				channelId: message.channel.id,
				messageId: message.id,
				attachments,
				reactions: reactions.length > 0 ? reactions : undefined,
			},
			sendTyping: async () => {
				const maybeSendTyping = (channel as { sendTyping?: unknown }).sendTyping;
				if (typeof maybeSendTyping === "function") {
					await (channel as { sendTyping: () => Promise<void> }).sendTyping();
				}
			},
			postPrimary: async (payload) => channel.send(payload),
			postText: async (content) => channel.send(content),
			postEmbed: async (embed) => channel.send({ embeds: [embed] }),
			uploadFile: async (filePath, title) => {
				const fileName = title || basename(filePath);
				const fileContent = readFileSync(filePath);
				const attachment = new AttachmentBuilder(fileContent, { name: fileName });
				await channel.send({ files: [attachment] });
			},
		});
	}

	async createContextFromInteraction(
		interaction: ChatInputCommandInteraction,
		messageText: string,
		workingDir: string,
	): Promise<TransportContext> {
		const guildId = interaction.guildId || undefined;
		const guildName = interaction.guild?.name;
		const channelId = interaction.channelId;
		const channelDir = this.store.getChannelDir(channelId, guildId);

		const userName = interaction.user.username;
		const displayName = interaction.user.displayName || interaction.user.username;

		let channelName: string | undefined;
		if (interaction.channel?.isTextBased() && !interaction.channel.isDMBased() && "name" in interaction.channel) {
			channelName = String((interaction.channel as { name?: string }).name);
		}
		if (channelName) {
			this.channelCache.set(channelId, channelName);
		}

		return this.createDiscordContext({
			workingDir,
			channelDir,
			channelName,
			guildId,
			guildName,
			message: {
				text: messageText,
				rawText: messageText,
				userId: interaction.user.id,
				userName,
				displayName,
				channelId,
				messageId: interaction.id,
				attachments: [],
			},
			postPrimary: async (payload) => (await interaction.editReply(payload)) as Message,
			postText: async (content) => (await interaction.followUp(content)) as Message,
			postEmbed: async (embed) => (await interaction.followUp({ embeds: [embed] })) as Message,
			uploadFile: async (filePath, title) => {
				const fileName = title || basename(filePath);
				const fileContent = readFileSync(filePath);
				const attachment = new AttachmentBuilder(fileContent, { name: fileName });
				await interaction.followUp({ files: [attachment] });
			},
		});
	}

	getClient(): Client {
		return this.client;
	}

	async start(botToken: string): Promise<void> {
		await this.client.login(botToken);
	}

	async stop(): Promise<void> {
		await this.client.destroy();
	}

	public async applyProfileUpdates(
		updates: Partial<DiscordProfileSettings>,
	): Promise<{ success: boolean; message: string }> {
		const user = this.client.user;
		if (!user) {
			return { success: false, message: "Discord client user not available yet (not ready)" };
		}

		const warnings: string[] = [];

		if (updates.status) {
			try {
				user.setStatus(updates.status);
			} catch (err) {
				warnings.push(`status: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		if (updates.activity) {
			try {
				user.setActivity(updates.activity.name, {
					type: mapDiscordActivityType(updates.activity.type),
				});
			} catch (err) {
				warnings.push(`activity: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		if (updates.username) {
			try {
				await user.setUsername(updates.username);
			} catch (err) {
				warnings.push(`username: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		if (updates.avatar !== undefined) {
			try {
				const avatar = updates.avatar.trim();
				if (avatar === "") {
					await user.setAvatar(null);
				} else {
					const buffer = await resolveAvatarBuffer(avatar, this.workingDir);
					await user.setAvatar(buffer);
				}
			} catch (err) {
				warnings.push(`avatar: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		if (warnings.length > 0) {
			return { success: false, message: `Some profile updates failed: ${warnings.join("; ")}` };
		}

		return { success: true, message: "Profile updates applied" };
	}

	public async updateProfile(
		updates: Partial<DiscordProfileSettings>,
	): Promise<{ success: boolean; message: string }> {
		if (!this.settingsManager) {
			return { success: false, message: "Discord settingsManager not configured; cannot persist profile updates" };
		}
		this.settingsManager.setDiscordProfile(updates);
		return await this.applyProfileUpdates(updates);
	}

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	async enqueueEvent(event: { channelId: string; text: string }): Promise<boolean> {
		if (!this.handler.onEvent) {
			log.logWarning("Discord: onEvent handler not configured, cannot process event");
			return false;
		}

		const queue = this.getQueue(event.channelId);
		if (queue.size() >= MAX_EVENT_QUEUE_SIZE) {
			log.logWarning(`Discord: Event queue full for ${event.channelId}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}

		log.logInfo(`Discord: Enqueueing event for ${event.channelId}: ${event.text.substring(0, 50)}`);

		queue.enqueue(async () => {
			try {
				const channel = await this.client.channels.fetch(event.channelId);
				if (!channel || !channel.isTextBased()) {
					log.logWarning(`Discord: Channel ${event.channelId} not found or not text-based`);
					return;
				}

				const guildId = "guildId" in channel ? (channel.guildId as string | null) : null;
				const channelName = "name" in channel ? (channel as { name?: string }).name : undefined;
				const guild = guildId ? await this.client.guilds.fetch(guildId).catch(() => null) : null;
				const guildName = guild?.name;
				const channelDir = this.store.getChannelDir(event.channelId, guildId || undefined);

				const ctx = this.createDiscordContext({
					workingDir: this.workingDir,
					channelDir,
					channelName: channelName || undefined,
					guildId: guildId || undefined,
					guildName,
					message: {
						text: event.text,
						rawText: event.text,
						userId: "EVENT",
						userName: "EVENT",
						displayName: "EVENT",
						channelId: event.channelId,
						messageId: Date.now().toString(),
						attachments: [],
					},
					postPrimary: async (payload) => (channel as PartialTextBasedChannelFields<boolean>).send(payload),
					postText: async (content) => (channel as PartialTextBasedChannelFields<boolean>).send(content),
					postEmbed: async (embed) =>
						(channel as PartialTextBasedChannelFields<boolean>).send({ embeds: [embed] }),
					uploadFile: async (filePath, title) => {
						const fileName = title || basename(filePath);
						const fileContent = readFileSync(filePath);
						const attachment = new AttachmentBuilder(fileContent, { name: fileName });
						await (channel as PartialTextBasedChannelFields<boolean>).send({ files: [attachment] });
					},
				});

				await this.handler.onEvent!(ctx, true);
			} catch (err) {
				log.logWarning("Discord: Failed to process event", err instanceof Error ? err.message : String(err));
			}
		});

		return true;
	}

	async askQuestion(params: {
		channelId: string;
		userId: string;
		prompt: string;
		options: string[];
		timeoutMs: number;
		signal?: AbortSignal;
	}): Promise<{ index: number; option: string }> {
		const channel = await this.client.channels.fetch(params.channelId).catch(() => null);
		if (!channel || !channel.isTextBased() || !this.isSendableTextChannel(channel)) {
			throw new Error(`Channel ${params.channelId} not found or not text-based`);
		}

		const questionId = randomUUID().replace(/-/g, "");
		const components = buildQuestionActionRows(questionId, params.options);
		const message = await (channel as PartialTextBasedChannelFields<boolean>).send({
			content: params.prompt,
			components,
		});

		return await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const pending = this.pendingQuestions.get(questionId);
				if (!pending) return;
				this.pendingQuestions.delete(questionId);
				if (pending.signal && pending.abortListener) {
					pending.signal.removeEventListener("abort", pending.abortListener);
				}
				void message
					.edit({
						content: `${params.prompt}\n\n*(Timed out waiting for a selection.)*`,
						components: buildQuestionActionRows(questionId, params.options, { disabled: true }),
					})
					.catch(() => {});
				reject(new Error("Question timed out"));
			}, params.timeoutMs);

			const entry: PendingQuestion = {
				questionId,
				channelId: params.channelId,
				userId: params.userId,
				prompt: params.prompt,
				options: params.options,
				message,
				timeout,
				resolve,
				reject,
			};

			if (params.signal) {
				const onAbort = () => {
					const pending = this.pendingQuestions.get(questionId);
					if (!pending) return;
					this.pendingQuestions.delete(questionId);
					clearTimeout(timeout);
					if (pending.signal && pending.abortListener) {
						pending.signal.removeEventListener("abort", pending.abortListener);
					}
					void message
						.edit({
							content: `${params.prompt}\n\n*(Canceled.)*`,
							components: buildQuestionActionRows(questionId, params.options, { disabled: true }),
						})
						.catch(() => {});
					reject(new Error("Question aborted"));
				};
				entry.signal = params.signal;
				entry.abortListener = onAbort;
				params.signal.addEventListener("abort", onAbort, { once: true });
			}

			this.pendingQuestions.set(questionId, entry);
		});
	}

	async addReaction(
		channelId: string,
		messageId: string,
		emoji: string,
	): Promise<{ success: boolean; message: string }> {
		try {
			const channel = await this.client.channels.fetch(channelId);
			if (!channel || !channel.isTextBased()) {
				return { success: false, message: `Channel ${channelId} not found or not text-based` };
			}
			const message = await (channel as { messages: { fetch: (id: string) => Promise<Message> } }).messages.fetch(
				messageId,
			);
			await message.react(emoji);
			return { success: true, message: `Reacted with ${emoji}` };
		} catch (err) {
			return { success: false, message: err instanceof Error ? err.message : String(err) };
		}
	}
}

const DISCORD_AVATAR_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_AVATAR_DOWNLOAD_TIMEOUT_MS = 10_000;

function mapDiscordActivityType(type: DiscordProfileActivityType): ActivityType {
	switch (type) {
		case "Playing":
			return ActivityType.Playing;
		case "Watching":
			return ActivityType.Watching;
		case "Listening":
			return ActivityType.Listening;
		case "Competing":
			return ActivityType.Competing;
		case "Streaming":
			return ActivityType.Streaming;
		default: {
			const exhaustive: never = type;
			return exhaustive;
		}
	}
}

function isHttpUrl(value: string): boolean {
	return value.startsWith("https://") || value.startsWith("http://");
}

async function resolveAvatarBuffer(avatar: string, workingDir: string): Promise<Buffer> {
	if (isHttpUrl(avatar)) {
		return await downloadUrlToBuffer(avatar, DISCORD_AVATAR_MAX_BYTES, 3);
	}

	let filePath = avatar;
	if (filePath.startsWith("/workspace/")) {
		filePath = filePath.replace("/workspace/", "");
	} else if (filePath === "/workspace") {
		filePath = "";
	}
	const resolved = resolve(workingDir, filePath);
	const stats = statSync(resolved);
	if (!stats.isFile()) {
		throw new Error(`Avatar path is not a file: ${resolved}`);
	}
	if (stats.size > DISCORD_AVATAR_MAX_BYTES) {
		throw new Error(`Avatar file too large: ${stats.size} bytes (max ${DISCORD_AVATAR_MAX_BYTES})`);
	}
	return readFileSync(resolved);
}

async function downloadUrlToBuffer(urlStr: string, maxBytes: number, remainingRedirects: number): Promise<Buffer> {
	const url = new URL(urlStr);
	const reqFn = url.protocol === "https:" ? httpsRequest : url.protocol === "http:" ? httpRequest : null;
	if (!reqFn) throw new Error(`Unsupported URL protocol: ${url.protocol}`);

	return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
		const req = reqFn(url, (res) => {
			const statusCode = res.statusCode ?? 0;
			const location = res.headers.location;

			if (statusCode >= 300 && statusCode < 400 && location) {
				if (remainingRedirects <= 0) {
					rejectPromise(new Error("Too many redirects while downloading avatar"));
					res.resume();
					return;
				}
				const nextUrl = new URL(location, url).toString();
				res.resume();
				downloadUrlToBuffer(nextUrl, maxBytes, remainingRedirects - 1)
					.then(resolvePromise)
					.catch(rejectPromise);
				return;
			}

			if (statusCode >= 400) {
				rejectPromise(new Error(`HTTP ${statusCode} while downloading avatar`));
				res.resume();
				return;
			}

			const chunks: Buffer[] = [];
			let totalBytes = 0;

			res.on("data", (chunk: Buffer) => {
				totalBytes += chunk.length;
				if (totalBytes > maxBytes) {
					req.destroy(new Error(`Downloaded avatar exceeds max size (${maxBytes} bytes)`));
					return;
				}
				chunks.push(chunk);
			});

			res.on("end", () => {
				resolvePromise(Buffer.concat(chunks));
			});

			res.on("error", (err) => {
				rejectPromise(err);
			});
		});

		req.setTimeout(DISCORD_AVATAR_DOWNLOAD_TIMEOUT_MS, () => {
			req.destroy(new Error(`Avatar download timed out after ${DISCORD_AVATAR_DOWNLOAD_TIMEOUT_MS}ms`));
		});

		req.on("error", (err) => rejectPromise(err));
		req.end();
	});
}
