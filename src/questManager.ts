import { APIApplication } from 'discord-api-types/v10';
import { solveCaptcha } from './captcha';
import { ClientQuest } from './client';
import type {
	AllQuestsResponse,
	CaptchaDataFromRequest,
	QuestTaskConfigType,
} from './interface';
import { Quest } from './quest';
import { Utils } from './utils';
import { notifyRewardClaimed } from './notify';
import { buildConnector, Client } from 'undici';

export class QuestManager implements Iterable<Quest> {
	private readonly quests = new Map<string, Quest>();
	public readonly client: ClientQuest;
	constructor(client: ClientQuest, quests: Quest[] = []) {
		this.client = client;
		quests.forEach((quest) => this.quests.set(quest.id, quest));
	}

	static async fromResponse(
		client: ClientQuest,
		response: AllQuestsResponse,
		fetchExcludedQuests = false,
	): Promise<QuestManager> {
		if (response.quest_enrollment_blocked_until !== null) {
			throw new Error(
				`Quest enrollment is blocked until ${response.quest_enrollment_blocked_until}.`,
			);
		}
		const questManager = new QuestManager(
			client,
			response.quests.map((quest) => Quest.create(quest)),
		);
		if (fetchExcludedQuests) {
			for (const quest of response.excluded_quests) {
				if (quest.id) {
					await questManager.addExcludedQuest(quest.id);
				}
			}
		}
		return Promise.resolve(questManager);
	}

	protected addExcludedQuest(questId: string) {
		// fetch quest details and add to quests
		return this.client.rest
			.get(`/quests/${questId}`)
			.then((response) => {
				const quest = Quest.create({
					id: questId,
					config: response as any,
					user_status: null,
					targeted_content: 0,
					preview: false,
				});
				console.log(
					`Added excluded quest "${quest.config.messages.quest_name}" to the quest manager.`,
				);
				this.quests.set(quest.id, quest);
			})
			.catch((err) => {
				console.error(
					`Failed to fetch excluded quest "${questId}".`,
					err.message,
				);
			});
	}

	[Symbol.iterator](): IterableIterator<Quest> {
		return this.quests.values();
	}

	get size(): number {
		return this.quests.size;
	}

	list(): Quest[] {
		return Array.from(this.quests.values());
	}

	get(id: string): Quest | undefined {
		return this.quests.get(id);
	}

	upsert(quest: Quest): void {
		this.quests.set(quest.id, quest);
	}

	remove(id: string): boolean {
		return this.quests.delete(id);
	}

	clear(): void {
		this.quests.clear();
	}

	getExpired(date: Date = new Date()): Quest[] {
		return this.list().filter((quest) => quest.isExpired(date));
	}

	getCompleted(): Quest[] {
		return this.list().filter((quest) => quest.isCompleted());
	}

	private static isClaimable(quest: Quest): boolean {
		return quest.isCompleted() && !quest.hasClaimedRewards();
	}

	getClaimable(): Quest[] {
		return this.list().filter(QuestManager.isClaimable);
	}

	hasQuest(id: string): boolean {
		return this.quests.has(id);
	}

	filterQuestsValidToDo() {
		return this.list().filter(
			(quest) => !quest.isCompleted() && !quest.isExpired(),
		);
	}

	filterQuestsValidToRedeem() {
		return this.getClaimable();
	}

	getApplicationData(ids: string[]) {
		const query = new URLSearchParams();
		ids.forEach((id) => query.append('application_ids', id));
		return this.client.rest.get(`/applications/public`, {
			query,
		}) as Promise<
			{
				// Partial<ApplicationData>
				id: string;
				name: string;
				icon: string;
				description: string;
				executables: {
					os: string;
					name: string;
					is_launcher: boolean;
				}[];
			}[]
		>;
	}

	/**
	 * Enroll in a quest.
	 * @param quest quest to enroll in
	 * @param isAndroid boolean
	 * @warning This API is heavily rate-limited (45 minutes). Use with caution.
	 */
	acceptQuest(quest: Quest, isAndroid = false): Promise<Quest | undefined> {
		// console.log(`Accepting quest "${questId}"...`);
		return this.client.rest
			.post(`/quests/${quest.id}/enroll`, {
				body: {
					location: isAndroid ? 12 : 11, // QUEST_HOME_MOBILE : QUEST_HOME_DESKTOP | https://docs.discord.food/resources/quests#quest-content-type
					// location: 19, // QUEST_SHARE_LINK
					is_targeted: false,
					metadata_sealed: null,
					traffic_metadata_raw: quest.raw.traffic_metadata_raw,
					traffic_metadata_sealed: quest.raw.traffic_metadata_sealed,
				},
				headers: {
					AndroidRequest: isAndroid ? 'true' : 'false',
				},
			})
			.then((r) => {
				const q = this.get(quest.id);
				q?.updateUserStatus(r as any);
				return q;
			});
	}

	private async timeout(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async redeemQuest(
		quest: Quest,
		retry = 0,
		captchaHeaders?: Record<string, string>,
	): Promise<boolean> {
		if (retry >= 3) {
			console.error(
				`Failed to redeem quest "${quest.config.messages.quest_name}" after ${retry} attempts.`,
			);
			return false;
		}
		if (!quest.isCompleted()) {
			console.error(`Cannot redeem rewards for an incomplete quest.`);
			return false;
		}
		if (quest.hasClaimedRewards()) {
			console.error(`Rewards for this quest have already been claimed.`);
			return false;
		}
		const agent = new Client('https://discord.com', {
				connect: buildConnector({
					ciphers: [
						'TLS_AES_128_GCM_SHA256',
						'TLS_AES_256_GCM_SHA384',
						'TLS_CHACHA20_POLY1305_SHA256',
						'ECDHE-ECDSA-AES128-GCM-SHA256',
						'ECDHE-RSA-AES128-GCM-SHA256',
						'ECDHE-ECDSA-AES256-GCM-SHA384',
						'ECDHE-RSA-AES256-GCM-SHA384',
						'ECDHE-ECDSA-CHACHA20-POLY1305',
						'ECDHE-RSA-CHACHA20-POLY1305',
						'ECDHE-RSA-AES128-SHA',
						'ECDHE-RSA-AES256-SHA',
						'AES128-GCM-SHA256',
						'AES256-GCM-SHA384',
						'AES128-SHA',
						'AES256-SHA',
					].join(':'),
				}),
			});
		// ponytail: questku minimal body (sealed only) — add raw/metadata_raw when 10008 persists
		const resolveSealed = (): string | null =>
			(quest.raw as any).traffic_metadata_sealed
			?? (quest.raw as any).config?.traffic_metadata_sealed
			?? (quest.config as any)?.traffic_metadata_sealed
			?? null;
		const sealedInitial = resolveSealed();
		console.log(`[debug] claim "${quest.config.messages.quest_name}" id=${quest.id} sealed=${sealedInitial ? `${String(sealedInitial).slice(0,16)}… len=${String(sealedInitial).length}` : 'null'} completed=${quest.isCompleted()} claimed=${quest.hasClaimedRewards()} retry=${retry} hasCaptchaHeaders=${Boolean(captchaHeaders)}`);
		const doClaim = (headers?: Record<string, string>, dispatcher?: Client, sealedOverride?: string | null) => {
			if (headers) console.log(`[debug] doClaim headers: ${Object.keys(headers).join(',')} sealed=${String(sealedOverride !== undefined ? sealedOverride : sealedInitial ?? 'null').slice(0,16)}…`);
			return this.client.rest.post(
				`/quests/${quest.id}/claim-reward`,
				{
					body: {
						platform: 0,
						location: 11, // QUEST_HOME_DESKTOP — matches questku
						is_targeted: false,
						metadata_sealed: null,
						traffic_metadata_sealed: sealedOverride !== undefined ? sealedOverride : sealedInitial,
					},
					headers,
					...(dispatcher ? { dispatcher } : {}),
				},
			) as Promise<any>;
		};

		const fetchFreshTraffic = async (): Promise<string | null | undefined> => {
			try {
				// primary: re-read from /quests/@me list (canonical source); fallback: /quests/:id config
				try {
					const all = await this.client.rest.get(`/quests/@me`) as any;
					const list: any[] = all?.quests ?? [];
					const found = list.find((q: any) => q.id === quest.id);
					if (found) {
						const sealed = found?.traffic_metadata_sealed ?? found?.config?.traffic_metadata_sealed ?? resolveSealed();
						if (sealed) { console.log(`[debug] fresh sealed from @me: ${String(sealed).slice(0, 16)}… len=${String(sealed).length}`); return sealed; }
						if (found?.traffic_metadata_sealed === null || found?.config?.traffic_metadata_sealed === null) return null;
					}
				} catch (e: any) { console.warn(`[debug] @me fetch failed: ${e?.message ?? String(e)}`); }
				const fresh = await this.client.rest.get(`/quests/${quest.id}`) as any;
				const cfg = fresh?.config ?? fresh;
				const sealed = fresh?.traffic_metadata_sealed ?? cfg?.traffic_metadata_sealed ?? resolveSealed();
				if (sealed) { console.log(`[debug] fresh sealed from /quests/${quest.id}: ${String(sealed).slice(0, 16)}… len=${String(sealed).length}`); return sealed; }
				if (fresh?.traffic_metadata_sealed === null || cfg?.traffic_metadata_sealed === null) return null;
			} catch (e: any) { console.warn(`[debug] fresh fetch failed: ${e?.message ?? String(e)}`); }
			console.log(`[debug] fresh sealed fallback to resolveSealed: ${String(resolveSealed() ?? 'null').slice(0, 16)}…`);
			return undefined;
		};

		const isAlreadyClaimed = (err: any): boolean =>
			err?.status === 409 || err?.code === 40010 || /already claimed/i.test(JSON.stringify(err?.rawError ?? err?.message ?? ''));

		const isUnknownMessage = (err: any): boolean => {
			const msg = err instanceof Error ? err.message : String(err);
			const raw = JSON.stringify(err?.rawError ?? '');
			return /Unknown Message/i.test(msg) || /Unknown Message/i.test(raw) || /10007/.test(raw) || /10008/.test(raw);
		};

		// 10008 can mean stale sealed OR payload shape — try progressively more complete bodies
		const tryAlternativeBodies = async (headers?: Record<string, string>, dispatcher?: Client): Promise<any> => {
			// variant A: omit sealed entirely (some quests have none)
			try { return await this.client.rest.post(`/quests/${quest.id}/claim-reward`, { body: { platform: 0, location: 11, is_targeted: false, metadata_sealed: null, traffic_metadata_sealed: null }, headers, ...(dispatcher ? { dispatcher } : {}) }) as Promise<any>; } catch {}
			// variant B: include raw if we have it (upstream uses both)
			const raw = (quest.raw as any).traffic_metadata_raw ?? null;
			const sealed = resolveSealed();
			if (raw) {
				try { return await this.client.rest.post(`/quests/${quest.id}/claim-reward`, { body: { platform: 0, location: 11, is_targeted: false, metadata_sealed: null, traffic_metadata_raw: raw, traffic_metadata_sealed: sealed }, headers, ...(dispatcher ? { dispatcher } : {}) }) as Promise<any>; } catch {}
			}
			throw new Error('Unknown Message');
		};

		const handleSuccess = async (res: any) => {
			console.log(
				`Claimed rewards for quest "${quest.config.messages.quest_name}"!`,
			);
			await notifyRewardClaimed(quest.config.messages.quest_name);
			quest.updateUserStatus(res ?? { claimed_at: new Date().toISOString() } as any);
			return true;
		};

		try {
			// questku: no custom TLS/dispatcher — browser fetch TLS. Try plain first.
			const res = await doClaim(captchaHeaders, undefined);
			return await handleSuccess(res);
		} catch (err: any) {
			const rawError = (err as any)?.rawError as CaptchaDataFromRequest | undefined;
			if (rawError?.captcha_key?.length && rawError?.captcha_sitekey) {
				const safeWarn = {
					captcha_service: rawError.captcha_service,
					captcha_sitekey: rawError.captcha_sitekey,
					captcha_session_id: rawError.captcha_session_id,
					captcha_rqtoken_preview: rawError.captcha_rqtoken ? `${rawError.captcha_rqtoken.slice(0, 12)}…` : undefined,
					captcha_rqdata_preview: rawError.captcha_rqdata ? `${rawError.captcha_rqdata.slice(0, 16)}…` : undefined,
					status: (err as any)?.status,
					code: (err as any)?.code,
				};
				console.warn(
					`Captcha required to redeem rewards for quest "${quest.config.messages.quest_name}".`,
					safeWarn,
				);

				// If already claimed by another race/retry, don't re-solve
				if (quest.hasClaimedRewards()) {
					console.log(`Quest "${quest.config.messages.quest_name}" already claimed (skip captcha retry).`);
					return true;
				}

				let solvedCaptchaKey: string;
				try {
					solvedCaptchaKey = await solveCaptcha(rawError);
				} catch (captchaError) {
					console.error(
						`Captcha solver failed for quest "${quest.config.messages.quest_name}". Skipping reward claim.`,
						captchaError instanceof Error ? captchaError.message : String(captchaError),
					);
					return false;
				}
				console.log('Captcha solved, retrying reward redemption...');

				const freshTraffic = await fetchFreshTraffic();
				const captchaRetryHeaders: Record<string, string> = {
					'x-captcha-key': solvedCaptchaKey,
					'x-captcha-rqtoken': rawError['captcha_rqtoken'],
					'x-captcha-session-id': rawError['captcha_session_id'],
					...(rawError.captcha_rqdata ? { 'x-captcha-rqdata': rawError.captcha_rqdata } : {}),
				};

				// Attempt 1: plain dispatcher (questku style) + fresh sealed
				try {
					const res = await doClaim(captchaRetryHeaders, undefined, freshTraffic);
					console.log(`Claimed rewards for quest "${quest.config.messages.quest_name}"! (after captcha)`);
					await notifyRewardClaimed(quest.config.messages.quest_name);
					quest.updateUserStatus(res);
					return true;
				} catch (retryErr: any) {
					const retryRaw = (retryErr as any)?.rawError as CaptchaDataFromRequest & { captcha_key?: string[] } | undefined;
					const retryIsCaptcha = Boolean(retryRaw?.captcha_key?.length && retryRaw?.captcha_sitekey);
					const retryIsInvalidResponse = retryIsCaptcha && JSON.stringify(retryRaw?.captcha_key ?? '').includes('invalid-response');

					// Token rejected -> solve again with fresh challenge (up to retry+1)
					if (retryIsCaptcha && retry < 2) {
						console.warn(`Captcha token rejected (${retryIsInvalidResponse ? 'invalid-response' : 'new challenge'}), re-solving (attempt ${retry + 2}/3)…`);
						try {
							const nextSolved = await solveCaptcha(retryRaw as CaptchaDataFromRequest);
							const nextHeaders: Record<string, string> = {
								'x-captcha-key': nextSolved,
								'x-captcha-rqtoken': (retryRaw as any).captcha_rqtoken,
								'x-captcha-session-id': (retryRaw as any).captcha_session_id,
								...((retryRaw as any).captcha_rqdata ? { 'x-captcha-rqdata': (retryRaw as any).captcha_rqdata } : {}),
							};
							// Recurse with next challenge (preserves retry counting)
							try { agent.close(); } catch {}
							return this.redeemQuest(quest, retry + 1, nextHeaders);
						} catch (nextCaptchaErr) {
							console.error(
								`Captcha re-solve failed for quest "${quest.config.messages.quest_name}".`,
								nextCaptchaErr instanceof Error ? nextCaptchaErr.message : String(nextCaptchaErr),
							);
							return false;
						}
					}

				if (isAlreadyClaimed(retryErr)) {
						console.log(`Quest "${quest.config.messages.quest_name}" already claimed (409).`);
						quest.updateUserStatus({ claimed_at: new Date().toISOString() } as any);
						return true;
					}
					if (isUnknownMessage(retryErr)) {
						console.warn(`Retry with custom dispatcher for "${quest.config.messages.quest_name}" (Unknown Message fallback)…`);
						try {
							const res2 = await doClaim(captchaRetryHeaders, agent, freshTraffic);
							console.log(`Claimed rewards for quest "${quest.config.messages.quest_name}"! (fallback dispatcher)`);
							await notifyRewardClaimed(quest.config.messages.quest_name);
							quest.updateUserStatus(res2);
							return true;
						} catch (fallbackErr: any) {
							const fbRaw = (fallbackErr as any)?.rawError;
							const fbIsCaptcha = Boolean(fbRaw?.captcha_key?.length && fbRaw?.captcha_sitekey);
							if (fbIsCaptcha && retry < 2) {
								console.warn(`Fallback also returned captcha challenge, re-solving…`);
								try {
									const fbSolved = await solveCaptcha(fbRaw as CaptchaDataFromRequest);
									const fbHeaders: Record<string, string> = {
										'x-captcha-key': fbSolved,
										'x-captcha-rqtoken': fbRaw.captcha_rqtoken,
										'x-captcha-session-id': fbRaw.captcha_session_id,
										...(fbRaw.captcha_rqdata ? { 'x-captcha-rqdata': fbRaw.captcha_rqdata } : {}),
									};
									try { agent.close(); } catch {}
									return this.redeemQuest(quest, retry + 1, fbHeaders);
								} catch {}
							}
							// ponytail: stale sealed vs body shape — try null sealed + raw variants before giving up
							if (isUnknownMessage(fallbackErr)) {
								try {
									const alt = await tryAlternativeBodies(captchaRetryHeaders, undefined);
									console.log(`Claimed rewards for quest "${quest.config.messages.quest_name}"! (alt body)`);
									await notifyRewardClaimed(quest.config.messages.quest_name);
									quest.updateUserStatus(alt);
									return true;
								} catch {}
								try {
									const alt2 = await tryAlternativeBodies(captchaRetryHeaders, agent);
									console.log(`Claimed rewards for quest "${quest.config.messages.quest_name}"! (alt body + dispatcher)`);
									await notifyRewardClaimed(quest.config.messages.quest_name);
									quest.updateUserStatus(alt2);
									return true;
								} catch {}
							}
							console.error(
								`Failed to redeem rewards for quest "${quest.config.messages.quest_name}" after captcha (fallback also failed).`,
								{ message: fallbackErr?.message, status: fallbackErr?.status, code: fallbackErr?.code, rawError: JSON.stringify(fallbackErr?.rawError ?? fallbackErr)?.slice(0, 2000) },
							);
							return false;
						}
					}
					console.error(
						`Failed to redeem rewards for quest "${quest.config.messages.quest_name}" after captcha.`,
						{ message: retryErr?.message, status: retryErr?.status, code: retryErr?.code, rawError: JSON.stringify(retryErr?.rawError ?? retryErr)?.slice(0, 2000) },
					);
					return false;
				}
			} else {
				if (isAlreadyClaimed(err)) {
					console.log(`Quest "${quest.config.messages.quest_name}" already claimed (409).`);
					quest.updateUserStatus({ claimed_at: new Date().toISOString() } as any);
					return true;
				}
				// Non-captcha failure — check Unknown Message fallback for initial claim without captcha
				if (isUnknownMessage(err) && !captchaHeaders) {
					console.warn(`Retry with custom dispatcher for "${quest.config.messages.quest_name}" (Unknown Message fallback)…`);
					try {
						const res2 = await doClaim(captchaHeaders, agent);
						console.log(`Claimed rewards for quest "${quest.config.messages.quest_name}"! (fallback dispatcher)`);
						await notifyRewardClaimed(quest.config.messages.quest_name);
						quest.updateUserStatus(res2);
						return true;
					} catch (fallbackErr: any) {
						console.error(
							`Failed to redeem rewards for quest "${quest.config.messages.quest_name}".`,
							{ message: fallbackErr?.message, status: fallbackErr?.status, code: fallbackErr?.code, rawError: JSON.stringify(fallbackErr?.rawError ?? fallbackErr)?.slice(0, 2000) },
						);
						return false;
					}
				}
				console.error(
					`Failed to redeem rewards for quest "${quest.config.messages.quest_name}".`,
					{ message: err?.message, status: err?.status, code: err?.code, rawError: JSON.stringify(err?.rawError ?? err)?.slice(0, 2000) },
				);
				return false;
			}
		} finally {
			try { agent.close(); } catch {}
		}
	}

	async doingQuest(quest: Quest) {
		const questName = quest.config.messages.quest_name;
		const isAndroid =
			Boolean(quest.config.task_config_v2.tasks.WATCH_VIDEO_ON_MOBILE) &&
			!Boolean(quest.config.task_config_v2.tasks.WATCH_VIDEO);
		if (!quest.isEnrolledQuest()) {
			console.log(
				`Enrolling in quest "${questName}" (${isAndroid ? 'Android' : 'Desktop'} version)...`,
			);
			try {
				await this.acceptQuest(quest, isAndroid);
			} catch (err: any) {
				console.error(
					`Failed to enroll in quest "${questName}".`,
					err?.message,
				);
				return;
			}
		} else {
			console.log(`Already enrolled in quest "${questName}".`);
		}
		const applicationName = quest.config.application.name;
		const taskConfig = quest.config.task_config_v2;
		const taskName = [
			'WATCH_VIDEO',
			'PLAY_ON_DESKTOP',
			'PLAY_ON_XBOX',
			'PLAY_ON_PLAYSTATION',
			'STREAM_ON_DESKTOP',
			'PLAY_ACTIVITY',
			'WATCH_VIDEO_ON_MOBILE',
			'ACHIEVEMENT_IN_ACTIVITY',
		].find(
			(x) => taskConfig.tasks[x as QuestTaskConfigType] != null,
		) as QuestTaskConfigType;
		const secondsNeeded = taskConfig.tasks[taskName].target;
		let secondsDone = quest.userStatus?.progress?.[taskName]?.value ?? 0;
		switch (taskName) {
			case 'WATCH_VIDEO':
			case 'WATCH_VIDEO_ON_MOBILE': {
				await this.doingWatchVideoQuest(
					quest,
					questName,
					secondsNeeded,
					secondsDone,
				);
				break;
			}
			case 'PLAY_ON_XBOX':
			case 'PLAY_ON_PLAYSTATION':
			case 'PLAY_ON_DESKTOP': {
				await this.doingPlayOnPlatformQuest(
					quest,
					questName,
					secondsNeeded,
					taskName,
					applicationName,
				);
				break;
			}
			case 'PLAY_ACTIVITY': {
				await this.doingPlayActivityQuest(
					quest,
					questName,
					secondsNeeded,
					taskName,
					applicationName,
				);
				break;
			}
			case 'STREAM_ON_DESKTOP': {
				console.log(
					'This no longer works in node for non-video quests. Use the discord desktop app to complete the',
					questName,
					'quest!',
				);
				break;
			}
			case 'ACHIEVEMENT_IN_ACTIVITY': {
				await this.doingAchievementInActivityQuest(quest, questName);
				break;
			}
			default: {
				console.log(
					'Unknown quest type. Use the discord desktop app to complete the',
					questName,
					'quest!',
				);
			}
		}
	}
	async doingWatchVideoQuest(
		quest: Quest,
		questName: string,
		secondsNeeded: number,
		secondsDone: number,
	) {
		const maxFuture = 10,
			speed = 7,
			interval = 7;
		const enrolledAt = quest.userStatus?.enrolled_at
			? new Date(quest.userStatus.enrolled_at as any).getTime()
			: Date.now();
		let completed = false;
		let fn = async () => {
			while (true) {
				const maxAllowed =
					Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
				const diff = maxAllowed - secondsDone;
				const timestamp = secondsDone + speed;
				if (diff >= speed) {
					const res = (await this.client.rest.post(
						`/quests/${quest.id}/video-progress`,
						{
							body: {
								timestamp: Math.min(
									secondsNeeded,
									timestamp + Math.random(),
								),
							},
						},
					)) as any;
					completed = res.completed_at != null;
					secondsDone = Math.min(secondsNeeded, timestamp);
				}

				if (timestamp >= secondsNeeded) {
					break;
				}
				await this.timeout(interval * 1000);
			}
			if (!completed) {
				await this.client.rest.post(
					`/quests/${quest.id}/video-progress`,
					{
						body: { timestamp: secondsNeeded },
					},
				);
			}
			console.log(`Quest "${questName}" completed!`);
			this.client.emitQuestCompleted(quest.id);
		};
		console.log(`Spoofing video for ${questName}.`);
		await fn();
	}
	async doingPlayOnPlatformQuest(
		quest: Quest,
		questName: string,
		secondsNeeded: number,
		taskName: string,
		applicationName: string,
	) {
		const interval = 20;
		let iters = 0;
		const MAX_ITERS = 300;
		while (!quest.isCompleted() && iters++ < MAX_ITERS) {
			if (quest.isExpired()) break;
			const secondsDone =
				(quest.userStatus?.progress?.[taskName]?.value as number) || 0;
			const res = await this.client.rest.post(
				`/quests/${quest.id}/heartbeat`,
				{
					body: {
						application_id: quest.config.application.id,
						terminal: false,
					},
				},
			);
			quest.updateUserStatus(res as any);
			console.log(
				`Spoofed your game to ${applicationName}. Wait for ${Math.ceil(
					(secondsNeeded - secondsDone) / 60,
				)} more minute(s).`,
			);
			await new Promise((resolve) =>
				setTimeout(resolve, interval * 1000),
			);
		}
		if (!quest.isCompleted()) {
			console.warn(`Quest "${questName}" not completed, stopping loop (expired or max iterations).`);
			return;
		}
		const res = await this.client.rest.post(
			`/quests/${quest.id}/heartbeat`,
			{
				body: {
					application_id: quest.config.application.id,
					terminal: true,
				},
			},
		);
		quest.updateUserStatus(res as any);
		console.log(`Quest "${questName}" completed!`);
		this.client.emitQuestCompleted(quest.id);
	}
	async doingPlayActivityQuest(
		quest: Quest,
		questName: string,
		secondsNeeded: number,
		taskName: string,
		applicationName: string,
	) {
		const interval = 20;
		const streamKey = 'call:1:1';
		let iters = 0;
		const MAX_ITERS = 300;
		while (!quest.isCompleted() && iters++ < MAX_ITERS) {
			if (quest.isExpired()) break;
			const secondsDone =
				(quest.userStatus?.progress?.[taskName]?.value as number) || 0;
			const res = await this.client.rest.post(
				`/quests/${quest.id}/heartbeat`,
				{
					body: { stream_key: streamKey, terminal: false },
				},
			);
			quest.updateUserStatus(res as any);
			console.log(
				`Spoofed your activity to ${applicationName}. Wait for ${Math.ceil(
					(secondsNeeded - secondsDone) / 60,
				)} more minute(s).`,
			);
			await new Promise((resolve) =>
				setTimeout(resolve, interval * 1000),
			);
		}
		if (!quest.isCompleted()) {
			console.warn(`Quest "${questName}" not completed, stopping loop (expired or max iterations).`);
			return;
		}
		const res = await this.client.rest.post(
			`/quests/${quest.id}/heartbeat`,
			{
				body: { stream_key: streamKey, terminal: true },
			},
		);
		quest.updateUserStatus(res as any);
		console.log(`Quest "${questName}" completed!`);
		this.client.emitQuestCompleted(quest.id);
	}
	async doingAchievementInActivityQuest(quest: Quest, questName: string) {
		// 1. Get application ID
		const applicationId = quest.config.application.id;
		const applicationName = quest.config.application.name;
		const questTarget =
			quest.config.task_config_v2.tasks.ACHIEVEMENT_IN_ACTIVITY.target;
		// 2. Authorize
		const query = new URLSearchParams({
			response_type: 'code',
			client_id: applicationId,
			scope: 'identify applications.commands applications.entitlements',
			state: '',
		});
		const res2 = (await this.client.rest.post(`/oauth2/authorize`, {
			query,
			body: {
				permissions: '0',
				authorize: true,
				integration_type: 1,
				location_context: {
					guild_id: '10000',
					channel_id: '10000',
					channel_type: 10000,
				},
			},
		})) as Record<string, any>;
		console.log(`Authorized application ${applicationName}`);
		const location = res2?.location;
		let authCode: string | null = null;
		if (location) {
			authCode = new URL(location).searchParams.get('code');
		}
		if (!authCode) {
			console.error(
				`No auth code received for application ${applicationName}. Cannot complete the quest.`,
			);
			return;
		}
		// 3. Complete achievement in activity
		const { token, error: authError, activityReferrer } = await Utils.authorizeDiscordSays(
			applicationId,
			quest.id,
			authCode,
			this.client,
		);
		if (authError || !token) {
			console.error(
				`Failed to authorize with Discord Says for application ${applicationName}. Cannot complete the quest.`,
				authError,
			);
			return;
		}
		const { success, error: progressError } =
			await Utils.progressDiscordSays(
				applicationId,
				quest.id,
				token,
				questTarget,
				activityReferrer,
			);
		if (progressError || !success) {
			console.error(
				`Failed to progress quest with Discord Says for application ${applicationName}. Cannot complete the quest.`,
				progressError,
			);
			return;
		}
		// 4. Deauthorize
		const res3 = (await this.client.rest.get(`/oauth2/tokens`)) as {
			id: string;
			scopes: string[];
			application: APIApplication;
			disclosures: number[];
		}[];
		const tokenInfo = res3.find((t) => t.application.id === applicationId);
		if (tokenInfo) {
			try {
				await this.client.rest.delete(`/oauth2/tokens/${tokenInfo.id}`);
				console.log(`Deauthorized application ${applicationName}`);
			} catch (err) {
				console.error(
					`Failed to deauthorize token for application ${applicationName}.`,
					(err as Error).message,
				);
			}
		}
		console.log(`Quest "${questName}" completed!`);
		this.client.emitQuestCompleted(quest.id);
	}
}
