import { fetch } from 'undici';

export type AccountReport = {
	account: string;
	completed: number;
	claimed: number;
	claimSkipped: boolean;
	durationSeconds: number;
	error?: string;
};

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function nowWib(): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Asia/Jakarta',
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(new Date()) + ' WIB';
}

export async function sendTelegram(content: string): Promise<void> {
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

export function notifyQuestCompleted(questId: string): Promise<void> {
	return sendTelegram([
		'🎯 <b>Quest Completed</b>',
		'',
		`🔗 <a href="https://discord.com/quests/${encodeURIComponent(questId)}">Open Quest</a>`,
		`⏱️ ${nowWib()}`,
	].join('\n'));
}

export function notifyRewardClaimed(questName: string): Promise<void> {
	return sendTelegram([
		'🎁 <b>Reward Claimed!</b>',
		'',
		`🏆 <b>${escapeHtml(questName)}</b>`,
		'✅ Reward added to your Discord account',
		`⏱️ ${nowWib()}`,
	].join('\n'));
}

export function notifyAccountReport(report: AccountReport): Promise<void> {
	const ok = !report.error;
	const lines = [
		`${ok ? '✅' : '❌'} <b>Discord Quest Report</b>`,
		`⏱️ ${nowWib()}`,
		'',
		`👤 <b>${escapeHtml(report.account)}</b>`,
		`  🎯 Completed: <b>${report.completed}</b>`,
		`  🎁 Claimed: <b>${report.claimed}</b>`,
		`  🔓 Auto-claim: <b>${report.claimSkipped ? 'Skipped — no NopeCHA key' : 'Enabled'}</b>`,
		`  ⚡ Duration: <b>${report.durationSeconds}s</b>`,
	];
	if (report.error) lines.push('', '🚨 <b>Error</b>', `<code>${escapeHtml(report.error)}</code>`);
	return sendTelegram(lines.join('\n'));
}
