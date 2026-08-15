import assert from 'node:assert/strict';
import test from 'node:test';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import { NoneCapSolver } from '../src/providers/nonecap';

test('returns token directly when create solve finishes during wait', async () => {
	const previousDispatcher = getGlobalDispatcher();
	const mockAgent = new MockAgent();
	mockAgent.disableNetConnect();
	setGlobalDispatcher(mockAgent);

	try {
		mockAgent
			.get('https://api.nonecap.com')
			.intercept({ path: '/v1/solves?wait=45', method: 'POST' })
			.reply(200, {
				id: 'solve_01TEST',
				status: 'solved',
				token: 'P1_test_token',
			});

		const token = await new NoneCapSolver('nc_live_test').hcaptcha(
			'test-sitekey',
			'https://discord.com',
			'test-rqdata',
		);

		assert.equal(token, 'P1_test_token');
		assert.equal(mockAgent.pendingInterceptors().length, 0);
	} finally {
		await mockAgent.close();
		setGlobalDispatcher(previousDispatcher);
	}
});

test('polls the solve id when create returns pending', async () => {
	const previousDispatcher = getGlobalDispatcher();
	const mockAgent = new MockAgent();
	mockAgent.disableNetConnect();
	setGlobalDispatcher(mockAgent);

	try {
		const pool = mockAgent.get('https://api.nonecap.com');
		pool.intercept({ path: '/v1/solves?wait=1', method: 'POST' }).reply(202, {
			id: 'solve_01PENDING',
			status: 'pending',
			token: null,
		});
		pool.intercept({ path: '/v1/solves/solve_01PENDING?wait=1', method: 'GET' }).reply(200, {
			id: 'solve_01PENDING',
			status: 'solved',
			token: 'P1_polled_token',
		});

		const token = await new NoneCapSolver('nc_live_test', undefined, 1).hcaptcha(
			'test-sitekey',
			'https://discord.com',
		);

		assert.equal(token, 'P1_polled_token');
		assert.equal(mockAgent.pendingInterceptors().length, 0);
	} finally {
		await mockAgent.close();
		setGlobalDispatcher(previousDispatcher);
	}
});
