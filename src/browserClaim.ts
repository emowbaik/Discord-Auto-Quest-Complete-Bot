import { solveCaptcha, solveHCaptchaRecognition } from './captcha';
import type { Quest } from './quest';
import type { HCaptchaTask } from './providers/nopechaRecognition';
import * as zlib from 'node:zlib';

// Browser claim: invisible execute -> token auto (no quota) or visible -> Recognition image click (free 100/day).
// ponytail: extension 0-kredit -> replace Recognition with extension wait

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
	let browser: any;
	try {
		const headless = process.env.BROWSER_HEADLESS !== 'false';
		browser = await chromium.launch({
			headless,
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
		});
		const context = await browser.newContext({
			locale: 'en-US',
			userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
			ignoreHTTPSErrors: true,
			bypassCSP: true,
		});
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
				let solved: string | null = null; let tokenBlocked = false;
				try { solved = await solveCaptcha(raw as any); } catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (/error 18|Feature unavailable|Reviewer/i.test(msg)) { tokenBlocked = true; console.warn(`[BrowserClaim] Token blocked (error 18) -> Recognition/invisible flow`); }
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
					const enc = (headers['content-encoding'] || '').toLowerCase();
					// try brotli first regardless of header — hcaptcha often sends br without header
					let triedBr=false;
					try {
						if (enc.includes('br') || !enc) { triedBr=true; try{ text=zlib.brotliDecompressSync(body).toString('utf-8'); if(!text.includes('request_type')&&!text.includes('tasklist')) throw new Error('not json'); }catch(e){ if(enc.includes('br')) throw e; text=''; } }
						if(!text){
							if (enc.includes('gzip')) text = zlib.gunzipSync(body).toString('utf-8');
							else if (enc.includes('deflate')) text = zlib.inflateSync(body).toString('utf-8');
							else if(!triedBr) text = zlib.brotliDecompressSync(body).toString('utf-8');
							else text = body.toString('utf-8');
						}
					} catch { try { if(!triedBr) text = zlib.brotliDecompressSync(body).toString('utf-8'); else text = body.toString('utf-8'); } catch { text = body.toString('utf-8'); } }
					console.log(`[BrowserClaim][Recognition] getcaptcha route raw ${text.slice(0, 900)}`);
					try { getcaptchaJson = JSON.parse(text); } catch {}
					const findTask = (obj: any, d = 0): any => { if (!obj || typeof obj !== 'object' || d > 6) return null; if (obj.request_type && Array.isArray(obj.tasklist)) return obj; for (const v of Object.values(obj)) { if (v && typeof v === 'object') { const r = findTask(v, d + 1); if (r) return r; } } return null; };
					const c = findTask(getcaptchaJson);
					if (c) { captured = c as HCaptchaTask; console.log(`[BrowserClaim][Recognition] captured via route ${captured.request_type} tasks=${captured.tasklist.length}`); }
				}
				// reconstruct response without content-encoding so browser gets plain text gate
				const newHeaders: Record<string, string> = { ...headers };
				delete newHeaders['content-encoding']; delete newHeaders['content-length'];
				await route.fulfill({ status: resp.status(), headers: newHeaders, body: text || body });
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
	try { console.log(`[BrowserClaim][Recognition] task json ${JSON.stringify(task).slice(0, 2500)}`); console.log(`[BrowserClaim][Recognition] solving ${(task as any).request_type} via NopeCHA (${task.tasklist.length} tasks)...`); result = await solveHCaptchaRecognition(task); console.log(`[BrowserClaim][Recognition] result: ${JSON.stringify(result).slice(0, 500)}`); } catch (e) { console.error(`[BrowserClaim][Recognition] solve failed:`, e instanceof Error ? e.message : String(e)); console.warn(`[BrowserClaim][Recognition] NopeCHA free tier gagal (error 10 Invalid request). Kemungkinan: IP datacenter diblock free tier / challenge belum support / quota 100/hari habis.`); console.warn(`[BrowserClaim][Recognition] Fallback: tunggu solve manual di browser ${!process.env.BROWSER_HEADLESS || process.env.BROWSER_HEADLESS==='false' ? '30s (silakan klik puzzle jika muncul)' : 'headless — set BROWSER_HEADLESS=false untuk manual'}`); // keep widget visible for manual
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
	if (!hcaptchaToken) { console.warn(`[BrowserClaim][Recognition] token empty after clicks`); return false; }
	return await claimWithToken(hcaptchaToken, captchaRaw, browserFetch, quest);
}

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
	if (reqType === 'image_drag_drop' || reqType === 'image_label_area_select') {
		// Result is array of {x,y,w,h} or {x,y} per task. Use coords to compute clicks/drags inside challenge iframe.
		// For now click center of each returned box — hCaptcha accepts click for area_select, drag for drag_drop may need drag.
		console.log(`[BrowserClaim][Recognition] ${reqType} result: ${JSON.stringify(result).slice(0, 600)}`);
		const frames = page.frames(); let challengeFrame: any = null;
		for (const f of frames) { try { const u = f.url(); if (u.includes('hcaptcha.com/captcha') || u.includes('hcaptcha.com/checkcaptcha') || u.includes('hcaptcha.com')) { challengeFrame = f; break; } } catch {} }
		if (!challengeFrame) challengeFrame = page.frameLocator('iframe[src*="hcaptcha.com"]').first();
		// Normalize result to list of boxes
		let boxes: any[] = [];
		if (Array.isArray(result) && result.length) {
			if (Array.isArray(result[0])) boxes = result[0] as any[];
			else if (result[0] && typeof result[0] === 'object' && 'x' in result[0]) boxes = result as any[];
		}
		console.log(`[BrowserClaim][Recognition] clicking ${boxes.length} boxes for ${reqType}`);
		for (const b of boxes) {
			const cx = b.x + (b.w ?? 20) / 2;
			const cy = b.y + (b.h ?? 20) / 2;
			try {
				if (challengeFrame.evaluate) {
					await challengeFrame.evaluate(({ x, y }: any) => {
						const el = document.elementFromPoint(x, y) as HTMLElement | null;
						if (el) el.click();
						else {
							// fallback click on image container center approximation
							const img = document.querySelector('.challenge-image, [class*="challenge"] img, .task-image') as HTMLElement | null;
							if (img) {
								const r = img.getBoundingClientRect();
								const tx = r.left + (x / 500) * r.width;
								const ty = r.top + (y / 500) * r.height;
								const t = document.elementFromPoint(tx, ty) as HTMLElement | null;
								if (t) t.click();
							}
						}
					}, { x: cx, y: cy });
				} else {
					await challengeFrame.locator('canvas, img').first().click({ position: { x: cx % 300, y: cy % 300 } }).catch(() => {});
				}
				await page.waitForTimeout(400);
			} catch {}
		}
		try { if (challengeFrame.evaluate) await challengeFrame.evaluate(() => { const b = (document.querySelector('[class*="button-submit"]') ?? document.querySelector('div.button-submit') ?? document.querySelector('button[type="submit"]')) as HTMLElement | null; if (b) b.click(); }); else await challengeFrame.locator('[class*="button-submit"], button').first().click({ timeout: 3000 }).catch(() => {}); } catch {}
		await page.waitForTimeout(1500); return;
	}
	throw new Error(`request_type ${reqType} not implemented`);
}
