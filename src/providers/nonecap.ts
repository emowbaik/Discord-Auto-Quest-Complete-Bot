import { fetch } from 'undici';

type SolveStatus = 'pending' | 'solving' | 'solved' | 'failed' | 'cancelled' | 'expired';

interface Solve {
	id: string;
	status: SolveStatus;
	token?: string | null;
	error?: { code: string; message: string } | null;
}

interface Envelope<T> { data?: T; error?: { code: string; message: string; param?: unknown }; }

export class NoneCapSolver {
	private static readonly baseUrl = 'https://api.nonecap.com/v1';

	constructor(
		private readonly apiKey: string,
		private readonly proxy?: string,
		private readonly waitSec = 45,
	) {}

	async hcaptcha(sitekey: string, url: string, rqdata?: string): Promise<string> {
		const type = rqdata ? 'hcaptcha_enterprise' : 'hcaptcha';
		const solve = await this.createSolve({ type, sitekey, url, rqdata });
		return solve.token ?? this.pollSolve(solve.id);
	}

	private async createSolve(body: { type: string; sitekey: string; url: string; rqdata?: string }): Promise<Solve> {
		const payload: Record<string, unknown> = {
			type: body.type,
			sitekey: body.sitekey,
			url: body.url,
		};
		if (body.rqdata) payload.rqdata = body.rqdata;
		if (this.proxy) payload.proxy = this.proxy;

		const response = await fetch(
			`${NoneCapSolver.baseUrl}/solves?wait=${this.waitSec}`,
			{ method: 'POST', headers: this.headers(), body: JSON.stringify(payload) },
		);
		const json = (await response.json()) as Solve & Envelope<Solve>;

		// 200 terminal, 202 pending/solving — both return a Solve object when structurally valid
		if ((response.status === 200 || response.status === 202) && json.id) {
			const solve = json as Solve;
			if (solve.status === 'solved' && !solve.token) {
				throw new Error('NoneCap solved response is missing its token');
			}
			if (solve.status === 'failed' || solve.status === 'expired' || solve.status === 'cancelled') {
				throw new Error(`NoneCap solve ${solve.status}: ${solve.error?.code ?? 'unknown'} ${solve.error?.message ?? ''}`.trim());
			}
			return solve;
		}

		const err = (json as Envelope<Solve>).error;
		throw new Error(`NoneCap create failed (${response.status}): ${err ? `${err.code} ${err.message}` : JSON.stringify(json)}`);
	}

	private async pollSolve(id: string): Promise<string> {
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 3000));
			const response = await fetch(
				`${NoneCapSolver.baseUrl}/solves/${encodeURIComponent(id)}?wait=${this.waitSec}`,
				{ headers: this.headers(false) },
			);
			const json = (await response.json()) as Solve & Envelope<Solve>;

			if (response.ok && json.id) {
				const solve = json as Solve;
				if (solve.status === 'solved' && solve.token) return solve.token;
				if (solve.status === 'failed' || solve.status === 'expired' || solve.status === 'cancelled') {
					throw new Error(`NoneCap solve ${solve.status}: ${solve.error?.code ?? 'unknown'} ${solve.error?.message ?? ''}`.trim());
				}
				// 202 pending/solving -> continue
				if (response.status === 202) continue;
				continue;
			}

			const err = (json as Envelope<Solve>).error;
			throw new Error(`NoneCap poll failed (${response.status}): ${err ? `${err.code} ${err.message}` : JSON.stringify(json)}`);
		}
		throw new Error('NoneCap timeout while waiting for hCaptcha token');
	}

	private headers(withJson = true): HeadersInit {
		const h: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
		if (withJson) h['Content-Type'] = 'application/json';
		return h;
	}
}
