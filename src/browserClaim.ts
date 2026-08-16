import { solveCaptcha, solveHCaptchaRecognition } from './captcha';
import type { Quest } from './quest';
import type { HCaptchaTask } from './providers/nopechaRecognition';

// Browser claim uses same Reviewer NOPECHA_API_KEY via Recognition image API (free 100/day).
// ponytail: extension 0-kredit -> replace Recognition solve with extension popup wait.

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
		await context.addInitScript((t: string) => {
			try { localStorage.setItem('token', `"${t}"`); } catch {}
		}, token);
		const page = await context.newPage();
		await page.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {} });
		console.log(`[BrowserClaim] opening discord for quest "${quest.config.messages.quest_name}" (${quest.id})`);
		await page.goto('https://discord.com/quest-home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
		await page.waitForTimeout(4000);
		try { await page.waitForSelector('div[class*="app"]', { timeout: 15000 }); } catch {}
		const sealed = (quest.raw as any).traffic_metadata_sealed ?? (quest.raw as any).config?.traffic_metadata_sealed ?? (quest.config as any)?.traffic_metadata_sealed ?? null;
		const bodyBase = { platform: 0, location: 11, is_targeted: false, metadata_sealed: null, traffic_metadata_sealed: sealed };
		const browserFetch = async (extraHeaders: Record<string, string> = {}, bodyOverride: any = null) => {
			const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: token, ...extraHeaders };
			const body = bodyOverride ?? bodyBase;
			return (await page.evaluate(
				async (args: { url: string; headers: Record<string, string>; body: any }) => {
					const res = await fetch(args.url, { method: 'POST', headers: args.headers, body: JSON.stringify(args.body), credentials: 'include' });
					let json: any = null; let text = '';
					try { text = await res.text(); json = text ? JSON.parse(text) : null; } catch { json = text ? { _raw: text } : null; }
					return { status: res.status, ok: res.ok, json, text: text.slice(0, 2000) };
				},
				{ url: `https://discord.com/api/v9/quests/${quest.id}/claim-reward`, headers, body },
			)) as { status: number; ok: boolean; json: any; text: string };
		};
		for (let attempt = 0; attempt < 3; attempt++) {
			const res = await browserFetch();
			if (res.ok) { console.log(`[BrowserClaim] claimed "${quest.config.messages.quest_name}" (browser, attempt ${attempt + 1})`); quest.updateUserStatus(res.json ?? ({ claimed_at: new Date().toISOString() } as any)); return true; }
			const j = res.json ?? {};
			if (res.status === 409 || j?.code === 40010 || /already claimed/i.test(JSON.stringify(j))) { console.log(`[BrowserClaim] already claimed (browser, ${res.status})`); quest.updateUserStatus({ claimed_at: new Date().toISOString() } as any); return true; }
			const raw = j as any; const needCaptcha = raw?.captcha_key?.length && raw?.captcha_sitekey;
			if (needCaptcha) {
				console.warn(`[BrowserClaim] captcha required (browser, attempt ${attempt + 1}) sitekey=${raw.captcha_sitekey}`);
				let solved: string | null = null; let tokenBlocked = false;
				try { solved = await solveCaptcha(raw as any); } catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (/error 18|Feature unavailable|Reviewer/i.test(msg)) { tokenBlocked = true; console.warn(`[BrowserClaim] Token blocked (error 18) -> Recognition flow`); }
					else { console.error(`[BrowserClaim] solve failed:`, msg); return false; }
				}
				if (solved && !tokenBlocked) {
					console.log(`[BrowserClaim] solved via Token, retrying...`);
					const captchaHeaders: Record<string, string> = { 'x-captcha-key': solved, 'x-captcha-rqtoken': raw.captcha_rqtoken, 'x-captcha-session-id': raw.captcha_session_id, ...(raw.captcha_rqdata ? { 'x-captcha-rqdata': raw.captcha_rqdata } : {}) };
					const res2 = await browserFetch(captchaHeaders);
					if (res2.ok) { console.log(`[BrowserClaim] claimed after captcha (browser)`); quest.updateUserStatus(res2.json ?? ({ claimed_at: new Date().toISOString() } as any)); return true; }
					const j2 = res2.json ?? {};
					if (res2.status === 409 || j2?.code === 40010) { console.log(`[BrowserClaim] already claimed after captcha`); quest.updateUserStatus({ claimed_at: new Date().toISOString() } as any); return true; }
					if (j2?.captcha_key?.length) { console.warn(`[BrowserClaim] captcha rejected, retrying...`); continue; }
					console.error(`[BrowserClaim] failed after captcha: ${res2.status} ${res2.text.slice(0, 500)}`); continue;
				}
				if (tokenBlocked) {
					const recogOk = await tryRecognitionSolve(page, raw, browserFetch, quest);
					if (recogOk) return true;
					console.warn(`[BrowserClaim] Recognition failed, fallback to direct API`); return false;
				}
				return false;
			}
			console.warn(`[BrowserClaim] claim failed ${res.status} ${res.text.slice(0, 500)}`); break;
		}
		console.warn(`[BrowserClaim] browser path did not claim, falling back to direct API`); return false;
	} catch (e) { console.warn(`[BrowserClaim] error:`, e instanceof Error ? e.message : String(e)); return false;
	} finally { try { await browser?.close(); } catch {} }
}

async function tryRecognitionSolve(page: any, captchaRaw: any, browserFetch: (h: Record<string, string>, b?: any) => Promise<{ status: number; ok: boolean; json: any; text: string }>, quest: Quest): Promise<boolean> {
	console.log(`[BrowserClaim][Recognition] image solve sitekey=${captchaRaw.captcha_sitekey}`);
	let captured: HCaptchaTask | null = null;
	const handler = async (response: any) => {
		try {
			const url = response.url(); if (!url.includes('hcaptcha.com')) return;
			const ct = response.headers()['content-type'] ?? ''; if (!ct.includes('json')) return;
			const json = await response.json().catch(() => null); if (!json) return;
			const data = json?.data ?? json?.c ?? json;
			if (data?.request_type && data?.tasklist && Array.isArray(data.tasklist)) { captured = data as HCaptchaTask; console.log(`[BrowserClaim][Recognition] captured ${data.request_type} tasks=${data.tasklist.length}`); }
			else if (json?.request_type && json?.tasklist) { captured = json as HCaptchaTask; console.log(`[BrowserClaim][Recognition] captured ${json.request_type}`); }
		} catch {}
	};
	page.on('response', handler);
	try {
		await page.evaluate(async (args: { sitekey: string; rqdata?: string }) => {
			const w = window as any; if (w.__hcaptchaInjected) return; w.__hcaptchaInjected = true;
			let div = document.getElementById('__hcaptcha_container');
			if (!div) { div = document.createElement('div'); div.id = '__hcaptcha_container'; div.style.position = 'fixed'; div.style.top = '10px'; div.style.left = '10px'; div.style.zIndex = '99999'; div.style.background = 'white'; div.style.padding = '8px'; document.body.appendChild(div); }
			if (!w.hcaptcha) {
				await new Promise<void>((resolve, reject) => {
					const s = document.createElement('script'); s.src = 'https://hcaptcha.com/1/api.js?render=explicit'; s.async = true; s.onload = () => resolve(); s.onerror = () => reject(new Error('hcaptcha load failed')); document.head.appendChild(s);
				});
				for (let i = 0; i < 30; i++) { if ((window as any).hcaptcha?.render) break; await new Promise((r) => setTimeout(r, 200)); }
			}
			const hc = (window as any).hcaptcha; if (!hc?.render) throw new Error('hcaptcha not ready');
			try { div.innerHTML = ''; } catch {}
			hc.render(div, { sitekey: args.sitekey, theme: 'dark', ...(args.rqdata ? { rqdata: args.rqdata } : {}) });
		}, { sitekey: captchaRaw.captcha_sitekey, rqdata: captchaRaw.captcha_rqdata });
	} catch (e) { console.warn(`[BrowserClaim][Recognition] inject failed:`, e instanceof Error ? e.message : String(e)); page.off('response', handler); return false; }
	for (let i = 0; i < 40; i++) { if (captured) break; await page.waitForTimeout(500); }
	page.off('response', handler);
	if (!captured) { console.warn(`[BrowserClaim][Recognition] no task captured (timeout)`); return false; }
	const task: HCaptchaTask = captured;
	let result: any;
	try { console.log(`[BrowserClaim][Recognition] solving ${(task as any).request_type}...`); result = await solveHCaptchaRecognition(task); console.log(`[BrowserClaim][Recognition] result: ${JSON.stringify(result).slice(0, 400)}`); } catch (e) { console.error(`[BrowserClaim][Recognition] solve failed:`, e instanceof Error ? e.message : String(e)); return false; }
	try { await applyRecognitionResult(page, task, result); } catch (e) { console.warn(`[BrowserClaim][Recognition] apply failed:`, e instanceof Error ? e.message : String(e)); return false; }
	let hcaptchaToken = '';
	for (let i = 0; i < 20; i++) { await page.waitForTimeout(1000); try { hcaptchaToken = await page.evaluate(() => { try { return (window as any).hcaptcha?.getResponse() ?? ''; } catch { return ''; } }); } catch {} if (hcaptchaToken) break; }
	if (!hcaptchaToken) { console.warn(`[BrowserClaim][Recognition] token empty after clicks`); return false; }
	console.log(`[BrowserClaim][Recognition] token len=${hcaptchaToken.length}, retrying claim...`);
	const captchaHeaders: Record<string, string> = { 'x-captcha-key': hcaptchaToken, 'x-captcha-rqtoken': captchaRaw.captcha_rqtoken, 'x-captcha-session-id': captchaRaw.captcha_session_id, ...(captchaRaw.captcha_rqdata ? { 'x-captcha-rqdata': captchaRaw.captcha_rqdata } : {}) };
	const res2 = await browserFetch(captchaHeaders);
	if (res2.ok) { console.log(`[BrowserClaim][Recognition] claimed after solve`); quest.updateUserStatus(res2.json ?? ({ claimed_at: new Date().toISOString() } as any)); return true; }
	const j2 = res2.json ?? {}; if (res2.status === 409 || j2?.code === 40010) { console.log(`[BrowserClaim][Recognition] already claimed`); quest.updateUserStatus({ claimed_at: new Date().toISOString() } as any); return true; }
	console.error(`[BrowserClaim][Recognition] claim failed: ${res2.status} ${res2.text.slice(0, 500)}`); return false;
}

async function applyRecognitionResult(page: any, task: HCaptchaTask, result: any): Promise<void> {
	if ((task as any).request_type === 'image_label_binary') {
		const grids: boolean[][] = Array.isArray(result[0]) ? (result as boolean[][]) : [result as boolean[]];
		const flat = grids[0] ?? [];
		console.log(`[BrowserClaim][Recognition] clicking tiles ${flat.map((v, i) => v ? i : -1).filter((x) => x >= 0).join(',')}`);
		const frames = page.frames(); let challengeFrame: any = null;
		for (const f of frames) { try { const u = f.url(); if (u.includes('hcaptcha.com/captcha') || u.includes('hcaptcha.com/checkcaptcha')) { challengeFrame = f; break; } } catch {} }
		if (!challengeFrame) challengeFrame = page.frameLocator('iframe[src*="hcaptcha.com"]').first();
		for (let idx = 0; idx < flat.length; idx++) { if (!flat[idx]) continue; try {
			if (challengeFrame.evaluate) await challengeFrame.evaluate((i: number) => { const sels = ['.task-image', '.challenge-container .image', '[class*="task-image"]', '.image-list .image', 'div[role="button"]']; let els: Element[] = []; for (const s of sels) { const f = document.querySelectorAll(s); if (f.length >= 9) { els = Array.from(f); break; } if (f.length > els.length) els = Array.from(f); } if (els[i]) (els[i] as HTMLElement).click(); }, idx);
			else await challengeFrame.locator('.task-image').nth(idx).click({ timeout: 5000 }).catch(() => {});
			await page.waitForTimeout(250);
		} catch {} }
		try { if (challengeFrame.evaluate) await challengeFrame.evaluate(() => { const b = (document.querySelector('[class*="button-submit"]') ?? document.querySelector('div.button-submit') ?? document.querySelector('button[type="submit"]')) as HTMLElement | null; if (b) b.click(); }); else await challengeFrame.locator('[class*="button-submit"], button').first().click({ timeout: 3000 }).catch(() => {}); } catch {}
		await page.waitForTimeout(1500); return;
	}
	throw new Error(`request_type ${task.request_type} not implemented (only image_label_binary ready)`);
}
