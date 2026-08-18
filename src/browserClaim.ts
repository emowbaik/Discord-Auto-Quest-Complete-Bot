import { solveCaptcha, solveHCaptchaRecognition } from './captcha';
import type { Quest } from './quest';
import type { HCaptchaTask } from './providers/openaiVision';
import * as zlib from 'node:zlib';

// Browser claim flow priority:
// 1. Extension (BROWSER_EXTENSION_PATH set) — NoneCap/etc auto-solves natively, best success rate
// 2. Vision API (OPENAI_BASE_URL set) — OpenAI-compatible vision provider, moderate success
// 3. Manual fallback — visible browser, user solves, bot auto-claims

const EXTENSION_PATH = process.env.BROWSER_EXTENSION_PATH ? path.resolve(process.env.BROWSER_EXTENSION_PATH) : '';
// Temp dir for each extension browser session (persistent context needs a dir)
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export async function claimViaBrowser(token: string, quest: Quest): Promise<boolean> {
	let pw: any;
	try {
		// @ts-ignore optional peer
		pw = await import('playwright');
	} catch {
		console.warn('[BrowserClaim] playwright not installed — run: npx playwright install chromium --with-deps');
		return false;
	}
	const { chromium } = pw;
	let browser: any; let context: any; let usingExtension = false;
	try {
		const headless = process.env.BROWSER_HEADLESS !== 'false';
		if (EXTENSION_PATH && fs.existsSync(EXTENSION_PATH)) {
			// Extension requires non-headless + persistent context
			usingExtension = true;
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-'));
			console.log(`[BrowserClaim] loading extension from ${EXTENSION_PATH}`);
			context = await chromium.launchPersistentContext(tmpDir, {
				headless: false, // extensions require non-headless
				locale: 'en-US',
				userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
				ignoreHTTPSErrors: true,
				bypassCSP: true,
				args: [
					'--no-sandbox', '--disable-setuid-sandbox',
					`--disable-extensions-except=${EXTENSION_PATH}`,
					`--load-extension=${EXTENSION_PATH}`,
					'--disable-blink-features=AutomationControlled',
				],
			});
			browser = context; // persistentContext acts as browser for close()
		} else {
			browser = await chromium.launch({
				headless,
				args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
			});
			context = await browser.newContext({
				locale: 'en-US',
				userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
				ignoreHTTPSErrors: true,
				bypassCSP: true,
			});
		}
		await context.addInitScript(() => { try { const w:any=window; if(w.__hcHook) return; w.__hcHook=true; w.__hcTask=null; const f:any=(o:any,d=0):any=>{if(!o||typeof o!=='object'||d>8) return null; if(o.request_type&&Array.isArray(o.tasklist)) return o; for(const v of Object.values(o as any)){if(v&&typeof v==='object'){const r=f(v,d+1); if(r) return r;}} return null;}; const h:any=(j:any)=>{try{const c=f(j); if(c){w.__hcTask=c; try{console.log('[hcaptcha hook] '+c.request_type+' tasks='+c.tasklist.length);}catch{}}}catch{}}; try{const o=(w.fetch as any).bind(w); w.fetch=async(...a:any)=>{const r:Response=await o(...a); try{const u=String(a[0]||''); if(u.includes('hcaptcha')||u.includes('getcaptcha')) (r as any).clone().json().then(h).catch(()=>{});}catch{} return r;};}catch{} try{const X:any=XMLHttpRequest.prototype,oo=(X as any).open,os=(X as any).send; (X.open as any)=function(this:any,m:string,u:string){(this as any)._url=u; return oo.apply(this,arguments as any);}; (X.send as any)=function(this:any,b:any){ const self:any=this; self.addEventListener('load', ()=>{ try{const url=String(self._url||self.responseURL||''); if(url.includes('hcaptcha')||url.includes('getcaptcha')){try{h(JSON.parse(String(self.responseText||'')));}catch{}}}catch{}}); return os.call(self,b);};}catch{}} catch{}});
	await context.addInitScript((t: string) => { try { localStorage.setItem('token', `"${t}"`); } catch {} }, token);
		const page = await context.newPage();
		await page.addInitScript(() => { try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {} });
		console.log(`[BrowserClaim] opening discord for quest "${quest.config.messages.quest_name}" (${quest.id})`);
		try {
			await page.goto('https://discord.com/quest-home', { waitUntil: 'domcontentloaded', timeout: 30_000 });
		} catch {
			console.warn('[BrowserClaim] goto quest-home timeout, trying discord.com');
			try { await page.goto('https://discord.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }); } catch {}
		}
		await page.waitForTimeout(4000);
		// check login actually worked (token valid) — detect login page
		try {
			const url = page.url();
			if (url.includes('/login')) console.warn(`[BrowserClaim] not logged in (redirected to login) — token invalid? url=${url}`);
		} catch {}
		try { await page.waitForSelector('div[class*="app"]', { timeout: 8000 }); } catch {}
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
				if (usingExtension) {
					// Extension path: NoneCap auto-solves inside iframe, poll for token
					console.log(`[BrowserClaim] Extension mode — waiting for NoneCap to auto-solve...`);
					const extOk = await tryExtensionSolve(page, raw, browserFetch, quest);
					if (extOk) return true;
					console.warn(`[BrowserClaim] Extension solve failed/timeout`); return false;
				}
				let tokenBlocked = false;
				try { await solveCaptcha(raw as any); } catch {
					tokenBlocked = true; console.warn(`[BrowserClaim] Token path unavailable -> Recognition/vision flow`);
				}
				if (tokenBlocked) {
					const recogOk = await tryRecognitionSolve(page, raw, browserFetch, quest);
					if (recogOk) return true;
					console.warn(`[BrowserClaim] Recognition/invisible failed, fallback to direct API`); return false;
				}
				return false;
			}
			console.warn(`[BrowserClaim] claim failed ${res.status} ${res.text.slice(0, 500)}`); break;
		}
		console.warn(`[BrowserClaim] browser path did not claim, falling back to direct API`); return false;
	} catch (e) { console.warn(`[BrowserClaim] error:`, e instanceof Error ? e.message : String(e)); return false;
	} finally { try { await browser?.close(); } catch {} }
}

async function claimWithToken(hcaptchaToken: string, captchaRaw: any, browserFetch: (h: Record<string, string>, b?: any) => Promise<{ status: number; ok: boolean; json: any; text: string }>, quest: Quest): Promise<boolean> {
	if (!hcaptchaToken) return false;
	console.log(`[BrowserClaim][Recognition] token len=${hcaptchaToken.length}, retrying claim...`);
	const captchaHeaders: Record<string, string> = { 'x-captcha-key': hcaptchaToken, 'x-captcha-rqtoken': captchaRaw.captcha_rqtoken, 'x-captcha-session-id': captchaRaw.captcha_session_id, ...(captchaRaw.captcha_rqdata ? { 'x-captcha-rqdata': captchaRaw.captcha_rqdata } : {}) };
	const res2 = await browserFetch(captchaHeaders);
	if (res2.ok) { console.log(`[BrowserClaim][Recognition] claimed after solve`); quest.updateUserStatus(res2.json ?? ({ claimed_at: new Date().toISOString() } as any)); return true; }
	const j2 = res2.json ?? {}; if (res2.status === 409 || j2?.code === 40010) { console.log(`[BrowserClaim][Recognition] already claimed`); quest.updateUserStatus({ claimed_at: new Date().toISOString() } as any); return true; }
	console.error(`[BrowserClaim][Recognition] claim with token failed: ${res2.status} ${res2.text.slice(0, 500)}`); return false;
}

async function tryExtensionSolve(
	page: any,
	captchaRaw: any,
	browserFetch: (h: Record<string, string>, b?: any) => Promise<{ status: number; ok: boolean; json: any; text: string }>,
	quest: Quest,
): Promise<boolean> {
	// Extension (NoneCap) auto-solves hCaptcha inside iframe widget.
	// We load the invisible widget, extension intercepts and solves it, then poll for the response token.
	console.log(`[BrowserClaim][Extension] sitekey=${captchaRaw.captcha_sitekey} rqdata=${captchaRaw.captcha_rqdata ? 'yes' : 'no'}`);

	const sitekey = captchaRaw.captcha_sitekey as string;
	const rqdata = captchaRaw.captcha_rqdata as string | undefined;
	const rqdataJson = rqdata ? JSON.stringify(rqdata) : 'null';

	// Load hCaptcha widget
	try {
		await page.addScriptTag({ url: 'https://js.hcaptcha.com/1/api.js?render=explicit' } as any);
		for (let i = 0; i < 50; i++) {
			const ok = await page.evaluate('!!(window.hcaptcha && window.hcaptcha.render)').catch(() => false);
			if (ok) break;
			await page.waitForTimeout(200);
		}
		await page.evaluate(`(() => {
			const w = window;
			if (w.__hcaptchaInjected) return;
			w.__hcaptchaInjected = true; w.__hcToken = '';
			let div = document.getElementById('__hcaptcha_container');
			if (!div) { div = document.createElement('div'); div.id = '__hcaptcha_container'; div.style.cssText = 'position:fixed;top:10px;left:10px;z-index:99999;background:white;padding:8px;'; document.body.appendChild(div); }
			const opts = {
				sitekey: ${JSON.stringify(sitekey)},
				size: 'invisible',
				theme: 'light',
				callback: function(tok) { w.__hcToken = tok; console.log('[hcaptcha callback] token len=' + (tok && tok.length || 0)); },
				'error-callback': function(e) { console.log('[hcaptcha error] ' + String(e)); },
			};
			const _rq = ${rqdataJson};
			if (_rq) opts.rqdata = _rq;
			const id = w.hcaptcha.render(div, opts);
			w.__hcWidgetId = id;
			// Give extension a moment to detect widget, then execute
			setTimeout(() => { try { w.hcaptcha.execute(id); } catch(e) { console.log('[hcaptcha execute error] ' + e); } }, 800);
		})()`).catch((e: any) => { throw e; });
	} catch (e) {
		console.warn(`[BrowserClaim][Extension] widget inject failed:`, e instanceof Error ? e.message : String(e));
		return false;
	}

	// Poll for token up to 90s — extension should solve automatically
	console.log(`[BrowserClaim][Extension] polling for token (max 90s)...`);
	for (let i = 0; i < 90; i++) {
		await page.waitForTimeout(1000);
		try {
			const tok: string = await page.evaluate(`(() => {
				const w = window;
				try { if (w.__hcToken) return w.__hcToken; } catch {}
				try { const id = w.__hcWidgetId; if (id !== null && id !== undefined) { const t = w.hcaptcha.getResponse(id); if (t) return t; } } catch {}
				try { return w.hcaptcha.getResponse() || ''; } catch {}
				return '';
			})()`).catch(() => '');
			if (tok) {
				console.log(`[BrowserClaim][Extension] token acquired len=${tok.length} after ${i + 1}s`);
				return await claimWithToken(tok, captchaRaw, browserFetch, quest);
			}
		} catch {}
		if (i % 15 === 14) console.log(`[BrowserClaim][Extension] waiting... ${i + 1}s`);
	}
	console.warn(`[BrowserClaim][Extension] timeout 90s — no token received. Extension installed? NoneCap configured?`);
	return false;
}

async function tryRecognitionSolve(page: any, captchaRaw: any, browserFetch: (h: Record<string, string>, b?: any) => Promise<{ status: number; ok: boolean; json: any; text: string }>, quest: Quest): Promise<boolean> {
	console.log(`[BrowserClaim][Recognition] image solve sitekey=${captchaRaw.captcha_sitekey}`);
	let captured: HCaptchaTask | null = null;
	let seenUrls: string[] = [];
	const handler = async (response: any) => {
		try {
			const url = response.url();
			if (!url.includes('hcaptcha')) return;
			seenUrls.push(url);
			if (seenUrls.length <= 12) console.log(`[BrowserClaim][Recognition] seen hcaptcha url: ${url} status=${response.status()}`);
		} catch {}
	};
	page.on('response', handler);
	const consoleHandler = (msg: any) => { try { const t = msg.text(); if (/\[hcaptcha|execute error|callback/i.test(t)) console.log(`[BrowserConsole] ${t.slice(0, 800)}`); } catch {} };
	page.on('console', consoleHandler);
	// Route to capture getcaptcha JSON body (compressed). page.route lets us read raw body before compression decoding fails.
	let getcaptchaJson: any = null;
	try {
		await page.route('**/getcaptcha**', async (route: any) => {
			try {
				const resp = await route.fetch();
				const headers = resp.headers();
				let body = await resp.body().catch(() => null);
				let text = '';
				if (body) {
					const rawUtf8 = body.toString('utf-8');
					if(rawUtf8.includes('request_type')) text=rawUtf8;
					else {
						const tryDec=(fn:()=>string,label:string)=>{ try{ const t=fn(); if(t.includes('request_type')){ console.log(`[BrowserClaim][Recognition] getcaptcha decoded via ${label}`); return t; } return ''; }catch{ return ''; } };
						text = tryDec(()=>zlib.brotliDecompressSync(body).toString('utf-8'),'br') || tryDec(()=>zlib.gunzipSync(body).toString('utf-8'),'gzip') || tryDec(()=>zlib.inflateSync(body).toString('utf-8'),'deflate') || rawUtf8;
					}
					console.log(`[BrowserClaim][Recognition] getcaptcha route raw ${text.slice(0, 900)}`);
					try { getcaptchaJson = JSON.parse(text); } catch {}
					const findTask = (obj: any, d = 0): any => { if (!obj || typeof obj !== 'object' || d > 6) return null; if (obj.request_type && Array.isArray(obj.tasklist)) return obj; for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const r = findTask(v, d + 1); if (r) return r; } } return null; };
					const c = findTask(getcaptchaJson);
					if (c) { captured = c as HCaptchaTask; console.log(`[BrowserClaim][Recognition] captured via route ${captured.request_type} tasks=${captured.tasklist.length}`); }
					const newHeaders: Record<string, string> = { ...headers };
					delete newHeaders['content-encoding']; delete newHeaders['content-length'];
					await route.fulfill({ status: resp.status(), headers: newHeaders, body: text || body });
				} else {
					await route.fulfill({ status: resp.status(), headers: resp.headers(), body });
				}
			} catch (e) { try { await route.continue(); } catch {} }
		});
	} catch {}
	let widgetId: any = null;
	try {
		let hcaptchaReady = false;
		try { await page.addScriptTag({ url: 'https://js.hcaptcha.com/1/api.js?render=explicit', type: 'text/javascript' } as any); hcaptchaReady = true; } catch (e) { console.warn(`[BrowserClaim][Recognition] addScriptTag js.hcaptcha.com failed:`, e instanceof Error ? e.message : String(e)); }
		if (!hcaptchaReady) { try { await page.addScriptTag({ url: 'https://hcaptcha.com/1/api.js?render=explicit' } as any); hcaptchaReady = true; } catch {} }
		// Use string evaluate to avoid tsx __name helper injection (ReferenceError: __name is not defined)
		for (let i = 0; i < 50; i++) { const has = await page.evaluate('!!(window.hcaptcha && window.hcaptcha.render)').catch(() => false); if (has) break; await page.waitForTimeout(200); }
		const hasHcaptcha = await page.evaluate('!!(window.hcaptcha && window.hcaptcha.render)').catch(() => false);
		if (!hasHcaptcha) throw new Error('hcaptcha not ready after script load (CSP blocked?)');
		// Render invisible widget via string evaluate (args embedded via JSON.stringify to avoid function serialization)
		const sitekey = captchaRaw.captcha_sitekey as string;
		const rqdata = captchaRaw.captcha_rqdata as string | undefined;
		const rqdataJson = rqdata ? JSON.stringify(rqdata) : 'null';
		try{ await page.evaluate(`(s=>{ try{ window.__hcSitekey=s; }catch{}})(${JSON.stringify(sitekey)})`); if(rqdata) await page.evaluate(`(r=>{ try{ window.__hcRq=r; }catch{}})(${JSON.stringify(rqdata)})`);}catch{}
		widgetId = await page.evaluate(`(() => {
			const w = window;
			if (w.__hcaptchaInjected) return w.__hcWidgetId ?? null;
			w.__hcaptchaInjected = true; w.__hcToken = '';
			let div = document.getElementById('__hcaptcha_container');
			if (!div) { div = document.createElement('div'); div.id = '__hcaptcha_container'; div.style.position = 'fixed'; div.style.top = '10px'; div.style.left = '10px'; div.style.zIndex = '99999'; div.style.background = 'white'; div.style.padding = '8px'; document.body.appendChild(div); }
			try { div.innerHTML = ''; } catch {}
			const opts = {
				sitekey: ${JSON.stringify(sitekey)},
				size: 'invisible',
				theme: 'dark',
				callback: function(tok) { w.__hcToken = tok; try { console.log('[hcaptcha callback] token len=' + (tok && tok.length || 0)); } catch {} },
				'error-callback': function(e) { try { console.log('[hcaptcha error-callback] ' + String(e).slice(0, 400)); } catch {} },
				'expired-callback': function() { try { console.log('[hcaptcha expired]'); } catch {} }
			};
			const _rq = ${rqdataJson};
			if (_rq) opts.rqdata = _rq;
			const id = w.hcaptcha.render(div, opts);
			w.__hcWidgetId = id; return id;
		})()`).catch((e: any) => { throw e; });
		console.log(`[BrowserClaim][Recognition] widgetId=${widgetId} executing invisible...`);
		await page.evaluate(`(id => { const w = window; try { if (id !== null && id !== undefined) w.hcaptcha.execute(id); else w.hcaptcha.execute(); } catch(e){ try{ console.log('[hcaptcha execute error] '+String(e).slice(0,400)); }catch{} } })(${JSON.stringify(widgetId)})`);
	} catch (e) { console.warn(`[BrowserClaim][Recognition] inject failed:`, e instanceof Error ? e.message : String(e)); page.off('response', handler); page.off('console', consoleHandler); return false; }
	let hcaptchaToken = '';
	for (let i = 0; i < 60; i++) {
		try { const hk:any = await page.evaluate('(() => { try { return (window as any).__hcTask || null; } catch { return null; } })()').catch(()=>null); if(hk && hk.request_type) { captured = hk as any; console.log(`[BrowserClaim][Recognition] captured via hook ${(captured as any).request_type} tasks=${(captured as any).tasklist?.length ?? 0}`); } } catch {}
		if (getcaptchaJson) {
			const findTask = (obj: any, d = 0): any => { if (!obj || typeof obj !== 'object' || d > 6) return null; if (obj.request_type && Array.isArray(obj.tasklist)) return obj; for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const r = findTask(v, d + 1); if (r) return r; } } return null; };
			const c = findTask(getcaptchaJson);
			if (c) { captured = c as HCaptchaTask; console.log(`[BrowserClaim][Recognition] captured via route ${(captured as any).request_type} tasks=${(captured as any).tasklist.length}`); }
			// only look once, then keep captured
		}
		if (captured) break;
		try {
			hcaptchaToken = await page.evaluate(`(id => { const w = window; try { if (w.__hcToken) return w.__hcToken; try { const t = w.hcaptcha.getResponse(id); if (t) return t; } catch {} return w.hcaptcha.getResponse() || ''; } catch { return ''; } })(${JSON.stringify(widgetId)})`).catch(() => '');
		} catch {}
		if (hcaptchaToken) {
			console.log(`[BrowserClaim][Recognition] invisible pass — token len=${hcaptchaToken.length} (no image challenge, no quota used)`);
			try { await page.unroute('**/getcaptcha**'); } catch {}
			page.off('response', handler); page.off('console', consoleHandler);
			return await claimWithToken(hcaptchaToken, captchaRaw, browserFetch, quest);
		}
		if (i % 10 === 0 && i > 0) console.log(`[BrowserClaim][Recognition] waiting token/task... ${i * 0.5}s seen=${seenUrls.length}`);

		await page.waitForTimeout(500);
	}// fallback: invisible stuck -> rerender visible and wait 20s for hook/route to capture challenge
if(!captured) { try{ const vis = await page.evaluate('(() => { try { const w:any=window; let d=document.getElementById("__hcaptcha_container"); if(!d) return false; d.innerHTML=""; const opts:any={sitekey:w.__hcSitekey,size:"normal",callback:function(t:any){w.__hcToken=t; try{console.log("[hcaptcha callback] visible token len="+(t&&t.length||0));}catch{}}}; if(w.__hcRq) opts.rqdata=w.__hcRq; const nid=w.hcaptcha.render(d, opts); w.__hcWidgetId=nid; return "visible:"+nid; } catch(e){ return String(e).slice(0,400);} })()').catch(()=>false); if(vis) console.log("[BrowserClaim][Recognition] fallback visible "+vis); for(let k=0;k<40;k++){ try{ const hk:any=await page.evaluate('(() => { try{return (window as any).__hcTask||null;}catch{return null;}})()'); if(hk&&hk.request_type){ captured=hk; console.log(`[BrowserClaim][Recognition] captured after visible ${hk.request_type}`); break; } if(getcaptchaJson){ const f2=(o:any,d=0):any=>{if(!o||typeof o!=='object'||d>6) return null; if(o.request_type&&Array.isArray(o.tasklist)) return o; for(const v of Object.values(o)) if(v&&typeof v==='object'){ const r=f2(v,d+1); if(r) return r;} return null;}; const c2=f2(getcaptchaJson); if(c2){captured=c2; break;}} const tok:any=await page.evaluate('(() => { try{return (window as any).__hcToken||"";}catch{return "";}})()'); if(tok){ console.log(`[BrowserClaim][Recognition] visible token len=${tok.length}`); try{await page.unroute('**/getcaptcha**');}catch{} page.off('response',handler); page.off('console',consoleHandler); return await claimWithToken(tok,captchaRaw,browserFetch,quest);} }catch{} await page.waitForTimeout(500); } }catch{}}
	if (!captured) {
		if (getcaptchaJson) {
			const findTask2 = (obj: any, d = 0): any => { if (!obj || typeof obj !== 'object' || d > 6) return null; if (obj.request_type && Array.isArray(obj.tasklist)) return obj; for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const r = findTask2(v, d + 1); if (r) return r; } } return null; };
			const c2 = findTask2(getcaptchaJson);
			if (c2) captured = c2 as HCaptchaTask;
		}
		if (!captured) {
			try {
				hcaptchaToken = await page.evaluate(`(id => { const w = window; try { if (w.__hcToken) return w.__hcToken; try { const t = w.hcaptcha.getResponse(id); if (t) return t; } catch {} return w.hcaptcha.getResponse() || ''; } catch { return ''; } })(${JSON.stringify(widgetId)})`).catch(() => '');
			} catch {}
			if (hcaptchaToken) { console.log(`[BrowserClaim][Recognition] late invisible token len=${hcaptchaToken.length}`); try { await page.unroute('**/getcaptcha**'); } catch {} page.off('response', handler); page.off('console', consoleHandler); return await claimWithToken(hcaptchaToken, captchaRaw, browserFetch, quest); }
			console.warn(`[BrowserClaim][Recognition] no task captured (timeout 30s). seen ${seenUrls.length} hcaptcha urls: ${seenUrls.slice(0, 5).join(', ') || 'none'}`);
			console.warn(`[BrowserClaim][Recognition] hint: invisible not passed + no visible challenge. Try BROWSER_HEADLESS=false to see widget, or claim manually in Discord app.`);
			try { await page.unroute('**/getcaptcha**'); } catch {}
			page.off('response', handler); page.off('console', consoleHandler); return false;
		}
	}
	page.off('console', consoleHandler);
	const task: HCaptchaTask = captured;
	let result: any;
	try { console.log(`[BrowserClaim][Recognition] task json ${JSON.stringify(task).slice(0, 2500)}`); console.log(`[BrowserClaim][Recognition] solving ${(task as any).request_type} via OpenAI Vision (${task.tasklist.length} tasks)...`); result = await solveHCaptchaRecognition(task); console.log(`[BrowserClaim][Recognition] result: ${JSON.stringify(result).slice(0, 500)}`); } catch (e) { console.error(`[BrowserClaim][Recognition] solve failed:`, e instanceof Error ? e.message : String(e)); console.warn(`[BrowserClaim][Recognition] Vision API gagal. Kemungkinan: API key invalid / endpoint down / model tidak support vision.`); console.warn(`[BrowserClaim][Recognition] Fallback: tunggu solve manual di browser ${!process.env.BROWSER_HEADLESS || process.env.BROWSER_HEADLESS==='false' ? '30s (silakan klik puzzle jika muncul)' : 'headless — set BROWSER_HEADLESS=false untuk manual'}`); // keep widget visible for manual
try{ await page.waitForTimeout(2000); }catch{}
let manualTok=''; for(let w=0;w<60;w++){ try{ manualTok=await page.evaluate(`(id=>{const w=window; try{if(w.__hcToken) return w.__hcToken; try{const t=w.hcaptcha.getResponse(id); if(t) return t;}catch{} return w.hcaptcha.getResponse()||'';}catch{return ''}})(${JSON.stringify(widgetId)})`).catch(()=>''); if(manualTok){ console.log(`[BrowserClaim][Recognition] manual token len=${manualTok.length}`); page.off('response', handler); try{await page.unroute('**/getcaptcha**');}catch{} page.off('console', consoleHandler); return await claimWithToken(manualTok, captchaRaw, browserFetch, quest);} }catch{} await page.waitForTimeout(1000); if(w%10===9) console.log(`[BrowserClaim][Recognition] menunggu manual... ${w+1}s`); }
page.off('response', handler); try { await page.unroute('**/getcaptcha**'); } catch {} page.off('console', consoleHandler); return false; }
	page.off('response', handler); try { await page.unroute('**/getcaptcha**'); } catch {}
	try { await applyRecognitionResult(page, task, result); } catch (e) { console.warn(`[BrowserClaim][Recognition] apply failed:`, e instanceof Error ? e.message : String(e)); return false; }
	hcaptchaToken = '';
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(1000);
		try {
			hcaptchaToken = await page.evaluate(`(id => { const w = window; try { if (w.__hcToken) return w.__hcToken; try { const t = w.hcaptcha.getResponse(id); if (t) return t; } catch {} return w.hcaptcha.getResponse() || ''; } catch { return ''; } })(${JSON.stringify(widgetId)})`).catch(() => '');
		} catch {}
		if (hcaptchaToken) break;
	}
	if (!hcaptchaToken) {
		// auto-solve rejected (hcaptcha "Please try again"). Give user a chance to solve manually in the (visible) iframe,
		// then bot auto-claims once token appears. This is the reliable free-tier path.
		console.warn(`[BrowserClaim][Recognition] token empty after clicks — switching to manual fallback`);
		if (!process.env.BROWSER_HEADLESS || process.env.BROWSER_HEADLESS==='false') console.warn(`[BrowserClaim][Recognition] Klik puzzle hCaptcha di browser yang terbuka (BROWSER_HEADLESS=false). Bot akan auto-claim saat selesai. Menunggu max 120s...`);
		else console.warn(`[BrowserClaim][Recognition] set BROWSER_HEADLESS=false untuk solve captcha secara manual lalu claim otomatis.`);
		for (let w = 0; w < 120; w++) {
			try {
				hcaptchaToken = await page.evaluate(`(id => { const w = window; try { if (w.__hcToken) return w.__hcToken; try { const t = w.hcaptcha.getResponse(id); if (t) return t; } catch {} return w.hcaptcha.getResponse() || ''; } catch { return ''; } })(${JSON.stringify(widgetId)})`).catch(() => '');
			} catch {}
			if (hcaptchaToken) break;
			await page.waitForTimeout(1000);
			if (w % 15 === 14) console.log(`[BrowserClaim][Recognition] menunggu manual solve... ${w + 1}s`);
		}
		if (!hcaptchaToken) { console.warn(`[BrowserClaim][Recognition] manual solve timeout — claim gagal`); return false; }
		console.log(`[BrowserClaim][Recognition] manual token acquired len=${hcaptchaToken.length}, claiming...`);
	}
	return await claimWithToken(hcaptchaToken, captchaRaw, browserFetch, quest);
}


function clamp(n:number,lo=0,hi=500){ return Math.max(lo,Math.min(hi,n)); }

async function applyRecognitionResult(page: any, task: HCaptchaTask, result: any): Promise<void> {
	const reqType = (task as any).request_type as string;
	if (reqType === 'image_label_binary') {
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
	if (reqType === 'image_drag_drop' ) {
		console.log(`[BrowserClaim][Recognition] ${reqType} result: ${JSON.stringify(result).slice(0, 600)}`);
		// drag from entity coords -> Vision API answer, using playwright page.mouse (trusted CDP events)
		let boxes:any[]=[]; if(Array.isArray(result)&&result.length){ if(Array.isArray(result[0])) boxes=result[0] as any[]; else if(result[0]&&typeof result[0]==='object'&&'x' in result[0]) boxes=result as any[]; }
		const tasklist=(task as any).tasklist as any[]; const entityEnt=tasklist?.[0]?.entities?.[0]; const eCoords=entityEnt?.coords as number[]|undefined; const eSize=entityEnt?.size as number[]|undefined;
		const b=boxes[0]||{x:250,y:250}; // Vision API answer normalized 0-500
		const fr=page.frames().find((f:any)=>{ try{ const u=f.url(); return u.includes('hcaptcha.com/captcha'); }catch{ return false; } });
		if(!fr) throw new Error('no challenge frame');
		const bb:any=await fr.locator('canvas').first().boundingBox().catch(()=>null) || await fr.locator('[class*="image"] img, .challenge-image img, img').first().boundingBox().catch(()=>null);
		if(bb){
			const sx=(eCoords?.[0]??250), sy=(eCoords?.[1]??250);
			// Vision API drag_drop returns x,y in 0-500 directly.
			const ex=b.x??250, ey=b.y??250;
			const x1=bb.x+((sx+(eSize?.[0]??0)/2)/500)*bb.width, y1=bb.y+((sy+(eSize?.[1]??0)/2)/500)*bb.height;
			const x2=bb.x+(clamp(ex)/500)*bb.width, y2=bb.y+(clamp(ey)/500)*bb.height;
			console.log(`[BrowserClaim][Recognition] drag (${sx},${sy})->(${ex},${ey}) canvas ${JSON.stringify(bb)}`);
			// human-like drag: ease-in-out velocity, slight curve, jitter, variable timing
			const rnd=(a:number,b:number)=>a+Math.random()*(b-a);
			await page.mouse.move(x1+rnd(-1,1), y1+rnd(-1,1) ,{steps: Math.round(rnd(3,6))});
			await page.waitForTimeout(rnd(60,140));
			await page.mouse.down();
			await page.waitForTimeout(rnd(80,180)); // human pause before moving
			const N=Math.round(rnd(14,22));
			// control point for slight arc (perpendicular offset)
			const mx=(x1+x2)/2+rnd(-40,40), my=(y1+y2)/2+rnd(-25,25);
			for(let i=1;i<=N;i++){
				const t=i/N;
				// bezier quadratic: p = (1-t)^2*P0 + 2(1-t)t*PC + t^2*P2
				const bx=(1-t)*(1-t)*x1+2*(1-t)*t*mx+t*t*x2;
				const by=(1-t)*(1-t)*y1+2*(1-t)*t*my+t*t*y2;
				await page.mouse.move(bx+rnd(-0.8,0.8), by+rnd(-0.8,0.8),{steps:1});
				// ease: slower at start & end (human accel/decel)
				const speed = t<0.5 ? (1-2*t)*60+120 : (2*(t-0.5))*60+120; // 180 -> 120 -> 180
				await page.waitForTimeout(rnd(speed*0.7, speed*1.3));
			}
			await page.mouse.move(x2+rnd(-1,1), y2+rnd(-1,1),{steps:2});
			await page.waitForTimeout(rnd(120,220));
			await page.mouse.up();
			await page.waitForTimeout(800);
			// debug iframe
			try{ const dbg2:any=await fr.evaluate(()=>{ const buts=[...document.querySelectorAll('button,[role="button"],[class*="button"],[class*="submit"]')].map(b=>({t:(b.textContent||'').trim().slice(0,15),c:(b.className||'').toString().slice(0,30),id:b.id,v:getComputedStyle(b).visibility})); return {body:(document.body?.innerText||'').slice(0,120),buttons:buts.slice(0,12),sub:!!document.querySelector('[class*="button-submit"],[class*="submit"]')}; }).catch(()=>null); if(dbg2) console.log(`[BrowserClaim][Recognition] iframe dbg ${JSON.stringify(dbg2).slice(0,900)}`); }catch{}
			try{
				const sbb:any=await fr.locator('[class*="button-submit"], .button-submit, button[type="submit"]').first().boundingBox().catch(()=>null);
				if(sbb){ await page.mouse.move(sbb.x+sbb.width/2, sbb.y+sbb.height/2,{steps:3}); await page.mouse.down(); await page.waitForTimeout(90); await page.mouse.up(); console.log(`[BrowserClaim][Recognition] real submit at ${JSON.stringify(sbb)}`); }
				else { await fr.evaluate(()=>{ const b=document.querySelector('[class*="button-submit"], .button-submit, button[type="submit"]') as HTMLElement|null; if(b) (b as any).click(); }); }
			}catch{}
			await page.waitForTimeout(3000);
			return;
		}
		throw new Error('no canvas boundingBox for drag');
	}
	if (reqType === 'image_label_area_select') {
		// Result is array of {x,y,w,h} or {x,y} per task. Use coords to compute clicks/drags inside challenge iframe.
		// For now click center of each returned box — hCaptcha accepts click for area_select, drag for drag_drop may need drag.
		console.log(`[BrowserClaim][Recognition] ${reqType} result: ${JSON.stringify(result).slice(0, 600)}`);
const frames = page.frames(); let challengeFrame: any = null;
		for (const f of frames) { try { const u = f.url(); if (u.includes('hcaptcha.com/captcha') || u.includes('hcaptcha.com/checkcaptcha') || u.includes('hcaptcha.com')) { challengeFrame = f; break; } } catch {} }
		if (!challengeFrame) challengeFrame = page.frameLocator('iframe[src*="hcaptcha.com"]').first();
		const boxes:any[]=[]; // legacy single
		const _tasklist=(task as any).tasklist as any[];
		const _allBoxes:Array<any[]> = Array.isArray(result[0]) && Array.isArray(result[0][0]) ? result as any[][] : (Array.isArray(result[0]) && typeof result[0][0]==='object' ? [result[0] as any[]] : (Array.isArray(result[0]) ? [result as any[]]: []));
		const tasklist=_tasklist; const allBoxes=_allBoxes;
		console.log(`[BrowserClaim][Recognition] clicking ${boxes.length} boxes for ${reqType}`);
		// click per-task sequence: first image -> submit -> second image -> submit
		for(let ti=0; ti<tasklist.length; ti++){
			const taskBoxes=allBoxes[ti]||allBoxes[0]||[];
			console.log(`[BrowserClaim][Recognition] task ${ti} clicking ${taskBoxes.length}`);
			for(const b of taskBoxes){
				const cx=b.x + (b.w||0)/2; const cy=b.y + (b.h||0)/2;
				const normX=Math.max(0,Math.min(500,cx)); const normY=Math.max(0,Math.min(500,cy));
				try{
					if(challengeFrame.evaluate){
						await challengeFrame.evaluate(({x,y}:any)=>{
							const inner=():HTMLElement|null=>{
								const img=document.querySelector('.challenge-image img, .task-image img, canvas, img') as HTMLElement|null;
								if(!img) return null;
								const r=img.getBoundingClientRect();
								const tx=r.left + (x/500)*r.width;
								const ty=r.top + (y/500)*r.height;
								return document.elementFromPoint(tx,ty) as HTMLElement|null || img;
							};
							const el=inner(); if(el) el.click();
						}, {x:normX, y:normY});
					} else {
	await challengeFrame.locator('canvas, img').first().click({ position:{x: normX%300, y: normY%100}}).catch(()=>{}); }
					await page.waitForTimeout(500);
				}catch{}
			}
			try{ if(challengeFrame.evaluate) await challengeFrame.evaluate(()=>{ const b=document.querySelector('[class*="button-submit"], .button-submit, button') as HTMLElement|null; if(b) b.click(); }); else await challengeFrame.locator('[class*="button-submit"], button').first().click({timeout:3000}).catch(()=>{});}catch{}
			await page.waitForTimeout(1800);
		}
		try{ if(challengeFrame.evaluate) await challengeFrame.evaluate(()=>{ const b=document.querySelector('[class*="button-submit"], .button-submit, button') as HTMLElement|null; if(b) b.click(); }); }catch{}
		await page.waitForTimeout(1500); return;
	}
	throw new Error(`request_type ${reqType} not implemented`);
}
