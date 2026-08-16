import { solveCaptcha } from './captcha';
import type { Quest } from './quest';

// ponytail: 0-kredit extension free -> replace solveCaptcha() with page.waitForSelector(extension popup)
// Browser claim uses same Reviewer NOPECHA_API_KEY pool as direct API, but via browser IP/TLS.

export async function claimViaBrowser(token: string, quest: Quest): Promise<boolean> {
	let pw: any;
	try {
		// @ts-ignore optional peer — installed only when BROWSER_CLAIM=true
		pw = await import('playwright');
	} catch {
		console.warn('[BrowserClaim] playwright not installed — run: npx playwright install chromium --with-deps');
		return false;
	}
	const { chromium } = pw;
	let browser: any;
	try {
		browser = await chromium.launch({
			headless: true,
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
		});
		const context = await browser.newContext({
			locale: 'en-US',
			userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
			ignoreHTTPSErrors: true,
		});
		// Discord web reads localStorage.token as JSON-quoted string
		await context.addInitScript((t: string) => {
			try {
				localStorage.setItem('token', `"${t}"`);
			} catch {}
		}, token);

		const page = await context.newPage();
		// reduce detection
		await page.addInitScript(() => {
			try {
				Object.defineProperty(navigator, 'webdriver', { get: () => false });
			} catch {}
		});

		console.log(`[BrowserClaim] opening discord for quest "${quest.config.messages.quest_name}" (${quest.id})`);
		await page.goto('https://discord.com/quest-home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
		await page.waitForTimeout(4000);
		// ensure logged in (app shell loads)
		try {
			await page.waitForSelector('div[class*="app"]', { timeout: 15000 });
		} catch {}

		const sealed =
			(quest.raw as any).traffic_metadata_sealed ??
			(quest.raw as any).config?.traffic_metadata_sealed ??
			(quest.config as any)?.traffic_metadata_sealed ??
			null;

		const bodyBase = {
			platform: 0,
			location: 11,
			is_targeted: false,
			metadata_sealed: null,
			traffic_metadata_sealed: sealed,
		};

		// Helper: do fetch inside browser context so IP/TLS = browser's
		const browserFetch = async (extraHeaders: Record<string, string> = {}, bodyOverride: any = null) => {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Authorization: token,
				...extraHeaders,
			};
			const body = bodyOverride ?? bodyBase;
			return (await page.evaluate(
				async (args: { url: string; headers: Record<string, string>; body: any }) => {
					const res = await fetch(args.url, {
						method: 'POST',
						headers: args.headers,
						body: JSON.stringify(args.body),
						credentials: 'include',
					});
					let json: any = null;
					let text = '';
					try {
						text = await res.text();
						json = text ? JSON.parse(text) : null;
					} catch {
						json = text ? { _raw: text } : null;
					}
					return { status: res.status, ok: res.ok, json, text: text.slice(0, 2000) };
				},
				{
					url: `https://discord.com/api/v9/quests/${quest.id}/claim-reward`,
					headers,
					body,
				},
			)) as { status: number; ok: boolean; json: any; text: string };
		};

		for (let attempt = 0; attempt < 3; attempt++) {
			const res = await browserFetch();
			if (res.ok) {
				console.log(`[BrowserClaim] claimed "${quest.config.messages.quest_name}" (browser, attempt ${attempt + 1})`);
				quest.updateUserStatus(res.json ?? ({ claimed_at: new Date().toISOString() } as any));
				return true;
			}
			const j = res.json ?? {};
			// already claimed
			if (res.status === 409 || j?.code === 40010 || /already claimed/i.test(JSON.stringify(j))) {
				console.log(`[BrowserClaim] already claimed (browser, ${res.status})`);
				quest.updateUserStatus({ claimed_at: new Date().toISOString() } as any);
				return true;
			}
			// captcha challenge?
			const raw = j as any;
			const needCaptcha = raw?.captcha_key?.length && raw?.captcha_sitekey;
			if (needCaptcha) {
				console.warn(`[BrowserClaim] captcha required (browser, attempt ${attempt + 1}) sitekey=${raw.captcha_sitekey}`);
				let solved: string;
				try {
					solved = await solveCaptcha(raw as any);
				} catch (e) {
					console.error(`[BrowserClaim] solve failed:`, e instanceof Error ? e.message : String(e));
					return false;
				}
				console.log(`[BrowserClaim] solved, retrying with x-captcha headers...`);
				const captchaHeaders: Record<string, string> = {
					'x-captcha-key': solved,
					'x-captcha-rqtoken': raw.captcha_rqtoken,
					'x-captcha-session-id': raw.captcha_session_id,
					...(raw.captcha_rqdata ? { 'x-captcha-rqdata': raw.captcha_rqdata } : {}),
				};
				const res2 = await browserFetch(captchaHeaders);
				if (res2.ok) {
					console.log(`[BrowserClaim] claimed after captcha (browser)`);
					quest.updateUserStatus(res2.json ?? ({ claimed_at: new Date().toISOString() } as any));
					return true;
				}
				const j2 = res2.json ?? {};
				if (res2.status === 409 || j2?.code === 40010) {
					console.log(`[BrowserClaim] already claimed after captcha`);
					quest.updateUserStatus({ claimed_at: new Date().toISOString() } as any);
					return true;
				}
				// if still captcha (invalid-response loop), continue to next attempt which will re-solve
				if (j2?.captcha_key?.length) {
					console.warn(`[BrowserClaim] captcha rejected (${JSON.stringify(j2.captcha_key).slice(0, 80)}), retrying...`);
					continue;
				}
				// try alt bodies (null sealed) inside browser as well
				const altBodies = [
					{ platform: 0, location: 11, is_targeted: false, metadata_sealed: null, traffic_metadata_sealed: null },
				];
				for (const alt of altBodies) {
					const resAlt = await browserFetch(captchaHeaders, alt);
					if (resAlt.ok) {
						console.log(`[BrowserClaim] claimed via alt body (browser)`);
						quest.updateUserStatus(resAlt.json ?? ({ claimed_at: new Date().toISOString() } as any));
						return true;
					}
				}
				console.error(`[BrowserClaim] failed after captcha: ${res2.status} ${res2.text.slice(0, 500)}`);
				// 10008 etc — let loop retry or fall through to direct API fallback
				continue;
			}
			// non-captcha error — log and break to fallback
			console.warn(`[BrowserClaim] claim failed ${res.status} ${res.text.slice(0, 500)}`);
			break;
		}
		console.warn(`[BrowserClaim] browser path did not claim, falling back to direct API`);
		return false;
	} catch (e) {
		console.warn(`[BrowserClaim] error:`, e instanceof Error ? e.message : String(e));
		return false;
	} finally {
		try {
			await browser?.close();
		} catch {}
	}
}
