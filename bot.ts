import { GatewayDispatchEvents } from 'discord-api-types/v10';
import { ClientQuest } from './src/client';
import { canSolveCaptcha } from './src/captcha';
import { notifyAccountReport } from './src/notify';

type AccountRunResult = {
	account: string;
	completed: number;
	claimed: number;
	claimSkipped: boolean;
	durationSeconds: number;
};

const tokens = (process.env.TOKENS || process.env.TOKEN || '')
	.split(/\r?\n/)
	.map((token) => token.trim())
	.filter(Boolean);

if (tokens.length === 0) {
	throw new Error('TOKENS or TOKEN environment variable is required.');
}

async function runAccount(token: string, index: number): Promise<AccountRunResult> {
	const client = new ClientQuest(token);
	const startedAt = Date.now();
	return new Promise<AccountRunResult>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error('Discord ready timeout')), 120_000);
		client.once(GatewayDispatchEvents.Ready, async ({ data }) => {
			clearTimeout(timeout);
			try {
				console.log(`[Account ${index + 1}] Logged in as @${data.user.username}`);
				await client.fetchQuests(false);
				const quests = client.questManager!.filterQuestsValidToDo();
				console.log(`[Account ${index + 1}] Found ${quests.length} valid quests.`);
				await Promise.allSettled(quests.map((quest) => client.questManager!.doingQuest(quest)));

				let claimed = 0;
				const claimSkipped = !canSolveCaptcha();
				if (!claimSkipped) {
					await client.fetchQuests(false);
					const claimable = client.questManager!.filterQuestsValidToRedeem();
					console.log(`[Account ${index + 1}] Found ${claimable.length} rewards to claim.`);
					claimed = claimable.length;
					for (const quest of claimable) {
						await client.questManager!.redeemQuest(quest);
					}
				} else {
					console.log('NOPECHA_API_KEY missing. Auto-claim skipped.');
				}

				resolve({
					account: `@${data.user.username}`,
					completed: quests.length,
					claimed,
					claimSkipped,
					durationSeconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
				});
			} catch (error) {
				reject(error);
			} finally {
				await client.destroy();
			}
		});
		client.connect().catch(reject);
	});
}

async function main(): Promise<void> {
	for (let index = 0; index < tokens.length; index++) {
		try {
			const result = await runAccount(tokens[index], index);
			await notifyAccountReport(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[Account ${index + 1}] Failed:`, message);
			await notifyAccountReport({
				account: `Account ${index + 1}`,
				completed: 0,
				claimed: 0,
				claimSkipped: !canSolveCaptcha(),
				durationSeconds: 0,
				error: message,
			});
		}
		if (index < tokens.length - 1) await new Promise((resolve) => setTimeout(resolve, 5000));
	}
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exitCode = 1;
});
