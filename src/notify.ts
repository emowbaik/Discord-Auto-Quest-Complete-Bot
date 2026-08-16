import { fetch } from 'undici';

export type AccountReport = {
	account: string;
	completed: number;
	claimed: number;
	claimSkipped: boolean;
	durationSeconds: number;
	error?: string;
};

type DiscordEmbed = {
	title: string;
	description?: string;
	url?: string;
	color: number;
	fields?: { name: string; value: string; inline?: boolean }[];
	footer?: { text: string };
	timestamp?: string;
};

const COLORS = {
	success: 0x57f287,
	error: 0xed4245,
	quest: 0x5865f2,
	reward: 0x9b59b6,
};

let warnedNoNotify = false;
function warnOnceIfNoNotify(): void {
	if (warnedNoNotify) return;
	if (!process.env.TG_BOT_TOKEN && !process.env.DISCORD_WEBHOOK_URL) {
		warnedNoNotify = true;
		console.warn('[notify] no TG_BOT_TOKEN/TG_CHAT_ID or DISCORD_WEBHOOK_URL configured, reports only in console');
	}
}

export function debugToTelegram(message: string, isWarn = false): void {
	if (isWarn) console.warn(message);
	else console.log(message);
	// ponytail: Telegram spam disabled — re-enable by uncommenting next line when diagnosing GH Actions without log tail
	// void sendTelegram(`${isWarn ? '⚠️ ' : ''}<code>${escapeHtml(message)}</code>`);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeDiscord(value: string): string {
	return value.replace(/([`*_~|\\])/g, '\\$1');
}

function nowWib(): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Asia/Jakarta',
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date()) + ' WIB';
}

export async function sendTelegram(content: string): Promise<void> {
	warnOnceIfNoNotify();
	const token = process.env.TG_BOT_TOKEN;
	const chatId = process.env.TG_CHAT_ID;
	if (!token || !chatId) return;

	try {
		const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				chat_id: chatId,
				text: content,
				parse_mode: 'HTML',
				disable_web_page_preview: true,
			}),
		});
		if (!response.ok) {
			console.warn(`Telegram notification failed: ${response.status} ${await response.text()}`);
		}
	} catch (error) {
		console.warn('Telegram notification failed:', error instanceof Error ? error.message : String(error));
	}
}

async function sendDiscordEmbed(embed: DiscordEmbed): Promise<void> {
	// webhook URL is bearer secret — never log
	warnOnceIfNoNotify();
	const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
	if (!webhookUrl) return;

	try {
		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				username: 'Discord Quest Bot',
				embeds: [{
					...embed,
					footer: embed.footer ?? { text: 'Discord Auto Quest Complete Bot' },
					timestamp: embed.timestamp ?? new Date().toISOString(),
				}],
			}),
		});
		if (!response.ok) {
			console.warn(`Discord webhook failed: ${response.status} ${await response.text()}`);
		}
	} catch (error) {
		console.warn('Discord webhook failed:', error instanceof Error ? error.message : String(error));
	}
}

export function notifyQuestCompleted(questId: string): Promise<void[]> {
	const questUrl = `https://discord.com/quests/${encodeURIComponent(questId)}`;
	return Promise.all([
		sendTelegram([
			'🎯 <b>Quest Completed</b>',
			'',
			`🔗 <a href="${questUrl}">Open Quest</a>`,
			`⏱️ ${nowWib()}`,
		].join('\n')),
		sendDiscordEmbed({
			title: '🎯 Quest Completed',
			description: 'Quest progress reached completion.',
			url: questUrl,
			color: COLORS.quest,
			fields: [
				{ name: 'Quest', value: `[Open Quest](${questUrl})`, inline: false },
				{ name: 'Time', value: nowWib(), inline: true },
			],
		}),
	]);
}

export function notifyRewardClaimed(questName: string): Promise<void[]> {
	return Promise.all([
		sendTelegram([
			'🎁 <b>Reward Claimed!</b>',
			'',
			`🏆 <b>${escapeHtml(questName)}</b>`,
			'✅ Reward added to your Discord account',
			`⏱️ ${nowWib()}`,
		].join('\n')),
		sendDiscordEmbed({
			title: '🎁 Reward Claimed!',
			description: 'Reward has been added to the Discord account.',
			color: COLORS.reward,
			fields: [
				{ name: 'Quest', value: escapeDiscord(questName || 'Unknown quest'), inline: false },
				{ name: 'Status', value: '✅ Claimed', inline: true },
				{ name: 'Time', value: nowWib(), inline: true },
			],
		}),
	]);
}

export function notifyAccountReport(report: AccountReport): Promise<void[]> {
	const ok = !report.error;
	const telegramLines = [
		`${ok ? '✅' : '❌'} <b>Discord Quest Report</b>`,
		`⏱️ ${nowWib()}`,
		'',
		`👤 <b>${escapeHtml(report.account)}</b>`,
		`  🎯 Completed: <b>${report.completed}</b>`,
		`  🎁 Claimed: <b>${report.claimed}</b>`,
		`  🔓 Auto-claim: <b>${report.claimSkipped ? 'Skipped — no NopeCHA key' : 'Enabled'}</b>`,
		`  ⚡ Duration: <b>${report.durationSeconds}s</b>`,
	];
	if (report.error) telegramLines.push('', '🚨 <b>Error</b>', `<code>${escapeHtml(report.error)}</code>`);

	const fields = [
		{ name: '👤 Account', value: escapeDiscord(report.account), inline: true },
		{ name: '🎯 Completed', value: String(report.completed), inline: true },
		{ name: '🎁 Claimed', value: String(report.claimed), inline: true },
		{ name: '🔓 Auto-claim', value: report.claimSkipped ? 'Skipped — no NopeCHA key' : 'Enabled', inline: true },
		{ name: '⚡ Duration', value: `${report.durationSeconds}s`, inline: true },
	];
	if (report.error) fields.push({ name: '🚨 Error', value: '```' + escapeDiscord(report.error.slice(0, 900)) + '```', inline: false }); // truncate to avoid embed limit

	return Promise.all([
		sendTelegram(telegramLines.join('\n')),
		sendDiscordEmbed({
			title: `${ok ? '✅' : '❌'} Discord Quest Report`,
			description: ok ? 'Account processed successfully.' : 'Account processing failed.',
			color: ok ? COLORS.success : COLORS.error,
			fields,
		}),
	]);
}
