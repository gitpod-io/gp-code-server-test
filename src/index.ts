import * as path from 'path';
import * as cp from 'child_process';
import * as playwright from '@playwright/test';
import * as url from 'url';
import * as tmp from 'tmp';
import * as rimraf from 'rimraf';
import { URI } from 'vscode-uri';
import * as kill from 'tree-kill';
import * as optimistLib from 'optimist';
import { promisify } from 'util';

const optimist = optimistLib
	.describe('endpoint', 'Url to a running server').string('endpoint')
	.describe('authCookie', 'Cookie to authenticate').string('authCookie')
	.describe('workspacePath', 'path to the workspace (folder or *.code-workspace file) to open in the test').string('workspacePath')
	.describe('extensionDevelopmentPath', 'path to the extension to test').string('extensionDevelopmentPath')
	.describe('extensionTestsPath', 'path to the extension tests').string('extensionTestsPath')
	.describe('debug', 'do not run browsers headless').boolean('debug')
	.describe('browser', 'browser in which integration tests should run').string('browser').default('browser', 'chromium')
	.describe('help', 'show the help').alias('help', 'h');

if (optimist.argv.help) {
	optimist.showHelp();
	process.exit(0);
}

const width = 1200;
const height = 800;

type BrowserType = 'chromium' | 'firefox' | 'webkit';

function getAuthCookie(): {
	name: string;
	value: string;
	url?: string;
	domain?: string;
	path?: string;
	expires?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
} | undefined {
	const authCookieStr = optimist.argv.authCookie || process.env.AUTH_COOKIE;
	if (authCookieStr) {
		const decodedCookie = Buffer.from(authCookieStr, 'base64').toString();
		const authCookie = JSON.parse(decodedCookie);
		if (typeof authCookie.expires === 'string') {
			authCookie.expires = +((new Date(authCookie.expires).getTime() / 1000).toFixed(0));
		}
		if (typeof authCookie.sameSite === 'string') {
			authCookie.sameSite = authCookie.sameSite.charAt(0).toUpperCase() + authCookie.sameSite.slice(1);
		}
		return authCookie
	}
	return undefined;
}

async function runTestsInBrowser(browserType: BrowserType, endpoint: url.UrlWithStringQuery, server: cp.ChildProcess | undefined): Promise<void> {
	const browser = await playwright[browserType].launch({ headless: true });
	const context = await browser.newContext();
	// Required for gitpod authentication
	const authCookie = getAuthCookie();
	if (authCookie) {
		await context.addCookies([authCookie]);
	}
	const page = await context.newPage();
	await page.setViewportSize({ width, height });

	page.on('pageerror', async error => console.error(`Playwright ERROR: page error: ${error}`));
	page.on('crash', () => console.error('Playwright ERROR: page crash'));
	page.on('response', async response => {
		if (response.status() >= 400) {
			console.error(`Playwright ERROR: HTTP status ${response.status()} for ${response.url()}`);
		}
	});
	page.on('console', async msg => {
		try {
			if (msg.type() === 'error' || msg.type() === 'warning') {
				consoleLogFn(msg)(msg.text(), await Promise.all(msg.args().map(async arg => await arg.jsonValue())));
			}
		} catch (err) {
			console.error('Error logging console', err);
		}
	});
	page.on('requestfailed', e => {
		console.error('Request Failed', e.url(), e.failure()?.errorText);
	});

	const host = endpoint.host;
	const protocol = 'vscode-remote';

	const testWorkspacePath = URI.file(path.resolve(optimist.argv.workspacePath)).path;
	const testExtensionUri = url.format({ pathname: URI.file(path.resolve(optimist.argv.extensionDevelopmentPath)).path, protocol, host, slashes: true });
	const testFilesUri = url.format({ pathname: URI.file(path.resolve(optimist.argv.extensionTestsPath)).path, protocol, host, slashes: true });

	const payloadParam = `[["extensionDevelopmentPath","${testExtensionUri}"],["extensionTestsPath","${testFilesUri}"],["enableProposedApi",""],["skipWelcome","true"]]`;

	if (path.extname(testWorkspacePath) === '.code-workspace') {
		await page.goto(`${endpoint.href}&workspace=${testWorkspacePath}&payload=${payloadParam}`);
	} else {
		await page.goto(`${endpoint.href}&folder=${testWorkspacePath}&payload=${payloadParam}`);
	}

	await page.exposeFunction('codeAutomationLog', (type: string, args: any[]) => {
		(console as any)[type](...args);
	});

	await page.exposeFunction('codeAutomationExit', async (code: number) => {
		try {
			await browser.close();
		} catch (error) {
			console.error(`Error when closing browser: ${error}`);
		}

		if (server) {
			try {
				await promisify(kill)(server.pid!);
			} catch (error) {
				console.error(`Error when killing server process tree (pid: ${server.pid}): ${error}`);
			}
		}

		process.exit(code);
	});
}

function consoleLogFn(msg: playwright.ConsoleMessage) {
	const type = msg.type();
	const candidate = (console as any)[type];
	if (candidate) {
		return candidate;
	}

	if (type === 'warning') {
		return console.warn;
	}

	return console.log;
}

async function launchServer(browserType: BrowserType): Promise<{ endpoint: url.UrlWithStringQuery, server: cp.ChildProcess }> {
	if (!process.env.VSCODE_REMOTE_SERVER_PATH) {
		return Promise.reject(new Error('VSCODE_REMOTE_SERVER_PATH env variable not provided'));
	}

	// Ensure a tmp user-data-dir is used for the tests
	const tmpDir = tmp.dirSync({ prefix: 't' });
	const testDataPath = tmpDir.name;
	process.once('exit', () => rimraf.sync(testDataPath));

	const userDataDir = path.join(testDataPath, 'd');

	const env = {
		VSCODE_BROWSER: browserType,
		...process.env
	};

	const serverArgs = ['--driver', 'web', '--enable-proposed-api', '--disable-telemetry', '--server-data-dir', userDataDir];
	const { serverApplicationName } = require(path.join(process.env.VSCODE_REMOTE_SERVER_PATH, 'product.json'));
	const serverLocation = path.join(process.env.VSCODE_REMOTE_SERVER_PATH, 'bin', `${serverApplicationName}${process.platform === 'win32' ? '.cmd' : ''}`);

	const stdio: cp.StdioOptions = optimist.argv.debug ? 'pipe' : ['ignore', 'pipe', 'ignore'];

	const serverProcess = cp.spawn(
		serverLocation,
		serverArgs,
		{ env, stdio }
	);

	if (optimist.argv.debug) {
		serverProcess.stderr!.on('data', error => console.log(`Server stderr: ${error}`));
		serverProcess.stdout!.on('data', data => console.log(`Server stdout: ${data}`));
	}

	process.on('exit', () => serverProcess.kill());
	process.on('SIGINT', () => {
		serverProcess.kill();
		process.exit(128 + 2); // https://nodejs.org/docs/v14.16.0/api/process.html#process_signal_events
	});
	process.on('SIGTERM', () => {
		serverProcess.kill();
		process.exit(128 + 15); // https://nodejs.org/docs/v14.16.0/api/process.html#process_signal_events
	});

	return new Promise(c => {
		serverProcess.stdout!.on('data', data => {
			const matches = data.toString('ascii').match(/Web UI available at (.+)/);
			if (matches !== null) {
				c({ endpoint: url.parse(matches[1]), server: serverProcess });
			}
		});
	});
}

let serverPromise: Promise<{ endpoint: url.UrlWithStringQuery, server: cp.ChildProcess | undefined }>;
if (optimist.argv.endpoint) {
	serverPromise = Promise.resolve({ endpoint: url.parse(optimist.argv.endpoint), server: undefined })
} else {
	serverPromise = launchServer(optimist.argv.browser);
}

serverPromise.then(
	({ endpoint, server }) => {
		return runTestsInBrowser(optimist.argv.browser, endpoint, server);
	},
	error => {
		console.error(error);
		process.exit(1);
	}
);
