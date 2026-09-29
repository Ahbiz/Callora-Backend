import http from 'http';
import { AddressInfo } from 'net';
import {
    dispatchWebhook,
    dispatchToAll,
    resetWebhookDispatcherForTests,
    stopWebhookDispatching,
    consumeCappedResponseBody,
    MAX_WEBHOOK_RESPONSE_BYTES,
} from './webhook.dispatcher.js';
import { WebhookStore } from './webhook.store.js';
import type { WebhookConfig, WebhookPayload } from './webhook.types.js';

// Mock DNS lookup so URL validation resolves deterministically with fake timers
// eslint-disable-next-line no-var
var mockDnsLookup = jest.fn().mockImplementation(async (hostname: string) => {
    if (hostname === '127.0.0.1' || hostname === 'localhost') {
        return [{ address: '127.0.0.1', family: 4 }];
    }
    return [{ address: '93.184.216.34', family: 4 }];
});

jest.mock('dns/promises', () => {
    const lookupFn = (...args: unknown[]) => mockDnsLookup(...args);
    return { __esModule: true, default: { lookup: lookupFn }, lookup: lookupFn };
});

describe('Webhook Dispatcher', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
        resetWebhookDispatcherForTests();
        jest.useFakeTimers();
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    const config: WebhookConfig = {
        developerId: 'dev_123',
        url: 'https://example.com/webhook',
        events: ['new_api_call'],
        createdAt: new Date(),
    };

    const payload: WebhookPayload = {
        event: 'new_api_call',
        timestamp: new Date().toISOString(),
        developerId: 'dev_123',
        data: { apiId: 'api_1' },
    };

    it('successfully dispatches webhook on first attempt', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;

        const promise = dispatchWebhook(config, payload);
        await Promise.resolve(); // flush microtasks
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(config.url);
        
        const headers = init.headers as Record<string, string>;
        expect(headers['X-Callora-Event']).toBe(payload.event);
        expect(headers['X-Callora-Delivery']).toBeDefined();
    });

    it('propagates the active request id to outbound webhook headers', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;
        const { runWithRequestContext } = await import('../utils/asyncContext.js');

        await runWithRequestContext({ requestId: 'req-webhook-als' }, async () => {
            await dispatchWebhook(config, payload);
        });

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['X-Request-Id']).toBe('req-webhook-als');
    });

    it('propagates the active correlation id to outbound webhook headers', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;
        const { runWithRequestContext } = await import('../utils/asyncContext.js');

        await runWithRequestContext(
            { requestId: 'req-webhook-corr', correlationId: 'corr-webhook-als' },
            async () => {
                await dispatchWebhook(config, payload);
            },
        );

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['X-Correlation-Id']).toBe('corr-webhook-als');
    });

    it('omits X-Request-Id header when no request context is set', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;

        await dispatchWebhook(config, payload);

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['X-Request-Id']).toBeUndefined();
    });

    it('includes all expected webhook headers on dispatch', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;
        const { runWithRequestContext } = await import('../utils/asyncContext.js');

        const configWithSecret: WebhookConfig = {
            ...config,
            secret: 'test-secret',
        };

        await runWithRequestContext({ requestId: 'req-test-123' }, async () => {
            await dispatchWebhook(configWithSecret, payload);
        });

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        expect(headers['User-Agent']).toBe('Callora-Webhook/1.0');
        expect(headers['X-Callora-Event']).toBe(payload.event);
        expect(headers['X-Callora-Timestamp']).toBe(payload.timestamp);
        expect(headers['X-Callora-Delivery']).toBeDefined();
        expect(headers['X-Request-Id']).toBe('req-test-123');
        expect(headers['X-Callora-Signature']).toMatch(/^sha256=/);
    });

    it('retries on non-2xx response and uses same idempotency key', async () => {
        const fetchMock = jest.fn()
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
            } as Response)
            .mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
            } as Response)
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                statusText: 'OK',
            } as Response);
            
        global.fetch = fetchMock as unknown as typeof fetch;

        const promise = dispatchWebhook(config, payload);
        
        // Wait for first attempt and sleep
        for (let i = 0; i < 3; i++) {
            await Promise.resolve(); // flush try/catch
            await Promise.resolve(); // wait for fetch promise
            await Promise.resolve(); // wait for fetch mock to resolve
            jest.runOnlyPendingTimers();
        }
        
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(3);
        
        const headers1 = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        const headers2 = fetchMock.mock.calls[1][1].headers as Record<string, string>;
        const headers3 = fetchMock.mock.calls[2][1].headers as Record<string, string>;

        expect(headers1['X-Callora-Delivery']).toBe(headers2['X-Callora-Delivery']);
        expect(headers2['X-Callora-Delivery']).toBe(headers3['X-Callora-Delivery']);
    });

    it('exhausts retries and propagates last error', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
        } as Response);
        
        global.fetch = fetchMock as unknown as typeof fetch;

        const promise = dispatchWebhook(config, payload);
        
        for (let i = 0; i < 5; i++) {
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            jest.runOnlyPendingTimers();
        }
        
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('does not start new deliveries after shutdown begins', async () => {
        const fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;

        stopWebhookDispatching();
        await dispatchWebhook(config, payload);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fans out settlement_completed payloads to every registered endpoint', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
        } as Response);
        global.fetch = fetchMock as unknown as typeof fetch;

        const settlementPayload: WebhookPayload = {
            event: 'settlement_completed',
            timestamp: new Date().toISOString(),
            developerId: 'dev_123',
            data: {
                settlementId: 'stl_001',
                amount: '25.5000000',
                asset: 'USDC',
                txHash: 'abc123',
                settledAt: new Date().toISOString(),
            },
        };

        const primary: WebhookConfig = {
            ...config,
            url: 'https://example.com/webhook-primary',
            events: ['settlement_completed'],
        };
        const secondary: WebhookConfig = {
            ...config,
            url: 'https://example.com/webhook-secondary',
            events: ['settlement_completed'],
        };

        const promise = dispatchToAll([primary, secondary], settlementPayload);
        await Promise.resolve();
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0][0]).toBe(primary.url);
        expect(fetchMock.mock.calls[1][0]).toBe(secondary.url);

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        expect(headers['X-Callora-Event']).toBe('settlement_completed');
    });

    describe('per-subscription retry policy', () => {
        it('uses custom maxRetries override when configured', async () => {
            const fetchMock = jest.fn().mockResolvedValue({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            } as Response);
            global.fetch = fetchMock as unknown as typeof fetch;

            const customConfig: WebhookConfig = {
                ...config,
                retryPolicy: { maxRetries: 2 },
            };

            WebhookStore.register(customConfig);

            const promise = dispatchWebhook(customConfig, payload);

            for (let i = 0; i < 2; i++) {
                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                jest.runOnlyPendingTimers();
            }

            await promise;

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('uses custom baseDelayMs override for exponential backoff', async () => {
            const fetchMock = jest.fn()
                .mockResolvedValueOnce({
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                } as Response)
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                } as Response);

            global.fetch = fetchMock as unknown as typeof fetch;

            const customConfig: WebhookConfig = {
                ...config,
                retryPolicy: { maxRetries: 3, baseDelayMs: 500 },
            };

            const promise = dispatchWebhook(customConfig, payload);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            jest.runOnlyPendingTimers();
            await promise;

            expect(fetchMock).toHaveBeenCalledTimes(2);
        });

        it('respects maxRetries of 0 (no retry attempts)', async () => {
            const fetchMock = jest.fn().mockResolvedValue({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            } as Response);
            global.fetch = fetchMock as unknown as typeof fetch;

            const customConfig: WebhookConfig = {
                ...config,
                retryPolicy: { maxRetries: 0 },
            };

            const promise = dispatchWebhook(customConfig, payload);
            await promise;

            expect(fetchMock).toHaveBeenCalledTimes(0);
        });

        it('uses default retry policy when subscription has no override', async () => {
            const fetchMock = jest.fn().mockResolvedValue({
                ok: true,
                status: 200,
                statusText: 'OK',
            } as Response);
            global.fetch = fetchMock as unknown as typeof fetch;

            const defaultConfig: WebhookConfig = {
                ...config,
            };

            const promise = dispatchWebhook(defaultConfig, payload);
            await Promise.resolve();
            await promise;

            // Default should be 5 retries but succeed on first attempt
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('SSRF Protection & Redirect Refusal (Issue #1262)', () => {
        let server: http.Server;
        let serverUrl: string;
        let receivedRequests: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders }>;
        let originalEnv: string | undefined;

        beforeEach(async () => {
            originalEnv = process.env.NODE_ENV;
            jest.useRealTimers();
            WebhookStore.clearFailedDeliveries();
            receivedRequests = [];

            await new Promise<void>((resolve) => {
                server = http.createServer((req, res) => {
                    receivedRequests.push({ method: req.method, url: req.url, headers: req.headers });

                    if (req.url === '/redirect-metadata-302') {
                        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
                        res.end('Redirecting to cloud metadata');
                        return;
                    }

                    if (req.url === '/redirect-internal-301') {
                        res.writeHead(301, { Location: 'http://127.0.0.1:8080/admin/secrets' });
                        res.end('Redirecting to internal admin');
                        return;
                    }

                    if (req.url === '/redirect-307') {
                        res.writeHead(307, { Location: 'http://10.0.0.1/private' });
                        res.end('Temporary redirect');
                        return;
                    }

                    if (req.url === '/large-response') {
                        res.writeHead(200, { 'Content-Type': 'text/plain' });
                        const chunk = 'A'.repeat(16 * 1024);
                        for (let i = 0; i < 16; i++) {
                            res.write(chunk);
                        }
                        res.end();
                        return;
                    }

                    if (req.url === '/success') {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ received: true }));
                        return;
                    }

                    res.writeHead(404);
                    res.end('Not found');
                });

                server.listen(0, '127.0.0.1', () => {
                    const address = server.address() as AddressInfo;
                    serverUrl = `http://127.0.0.1:${address.port}`;
                    resolve();
                });
            });
        });

        afterEach(async () => {
            process.env.NODE_ENV = originalEnv;
            if (server) {
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        });

        it('does not follow 302 redirect to an internal metadata address and records failure reason', async () => {
            const redirectConfig: WebhookConfig = {
                developerId: 'dev_ssrf_test',
                url: `${serverUrl}/redirect-metadata-302`,
                events: ['new_api_call'],
                createdAt: new Date(),
            };

            await dispatchWebhook(redirectConfig, payload);

            expect(receivedRequests.length).toBe(1);
            expect(receivedRequests[0].url).toBe('/redirect-metadata-302');

            const failures = WebhookStore.getRecentFailures();
            const failure = failures.find((f) => f.url === redirectConfig.url);
            expect(failure).toBeDefined();
            expect(failure?.lastError).toContain('HTTP 302');
            expect(failure?.lastError).toContain('http://169.254.169.254/latest/meta-data');
            expect(failure?.lastError).toContain('redirects are not followed');
        });

        it('does not follow 301 redirect to internal service and records failure', async () => {
            const redirectConfig: WebhookConfig = {
                developerId: 'dev_ssrf_test',
                url: `${serverUrl}/redirect-internal-301`,
                events: ['new_api_call'],
                createdAt: new Date(),
            };

            await dispatchWebhook(redirectConfig, payload);

            expect(receivedRequests.length).toBe(1);
            expect(receivedRequests[0].url).toBe('/redirect-internal-301');

            const failures = WebhookStore.getRecentFailures();
            const failure = failures.find((f) => f.url === redirectConfig.url);
            expect(failure).toBeDefined();
            expect(failure?.lastError).toContain('HTTP 301');
            expect(failure?.lastError).toContain('redirects are not followed');
        });

        it('does not follow 307 temporary redirect', async () => {
            const redirectConfig: WebhookConfig = {
                developerId: 'dev_ssrf_test',
                url: `${serverUrl}/redirect-307`,
                events: ['new_api_call'],
                createdAt: new Date(),
            };

            await dispatchWebhook(redirectConfig, payload);

            expect(receivedRequests.length).toBe(1);
            const failures = WebhookStore.getRecentFailures();
            const failure = failures.find((f) => f.url === redirectConfig.url);
            expect(failure).toBeDefined();
            expect(failure?.lastError).toContain('HTTP 307');
        });

        it('delivers successfully to 200 OK endpoint on local server', async () => {
            const successConfig: WebhookConfig = {
                developerId: 'dev_ssrf_test',
                url: `${serverUrl}/success`,
                events: ['new_api_call'],
                createdAt: new Date(),
            };

            await dispatchWebhook(successConfig, payload);

            expect(receivedRequests.length).toBe(1);
            expect(receivedRequests[0].url).toBe('/success');
            const failures = WebhookStore.getRecentFailures();
            expect(failures.find((f) => f.url === successConfig.url)).toBeUndefined();
        });

        it('caps response body reads to MAX_WEBHOOK_RESPONSE_BYTES (64 KB)', async () => {
            const largeBodyConfig: WebhookConfig = {
                developerId: 'dev_ssrf_test',
                url: `${serverUrl}/large-response`,
                events: ['new_api_call'],
                createdAt: new Date(),
            };

            await dispatchWebhook(largeBodyConfig, payload);
            expect(receivedRequests.length).toBe(1);

            const response = await fetch(`${serverUrl}/large-response`);
            const consumed = await consumeCappedResponseBody(response, MAX_WEBHOOK_RESPONSE_BYTES);
            expect(Buffer.byteLength(consumed, 'utf8')).toBeLessThanOrEqual(MAX_WEBHOOK_RESPONSE_BYTES);
        });

        it('refuses dispatch at dispatch time when DNS resolves to private range', async () => {
            process.env.NODE_ENV = 'production';

            mockDnsLookup.mockResolvedValueOnce([
                { address: '169.254.169.254', family: 4 },
            ]);

            const privateDnsConfig: WebhookConfig = {
                developerId: 'dev_ssrf_test',
                url: 'https://dynamic-rebind.example.com/webhook',
                events: ['new_api_call'],
                createdAt: new Date(),
            };

            await dispatchWebhook(privateDnsConfig, payload);

            const failures = WebhookStore.getRecentFailures();
            const failure = failures.find((f) => f.url === privateDnsConfig.url);
            expect(failure).toBeDefined();
            expect(failure?.lastError).toContain('resolves to a private/internal IP address (169.254.169.254)');
            expect(failure?.attempts).toBe(0);
        });

        it('refuses dispatch at dispatch time when hostname DNS fails to resolve', async () => {
            mockDnsLookup.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND invalid.domain'));

            const invalidDnsConfig: WebhookConfig = {
                developerId: 'dev_ssrf_test',
                url: 'https://invalid.domain/webhook',
                events: ['new_api_call'],
                createdAt: new Date(),
            };

            await dispatchWebhook(invalidDnsConfig, payload);

            const failures = WebhookStore.getRecentFailures();
            const failure = failures.find((f) => f.url === invalidDnsConfig.url);
            expect(failure).toBeDefined();
            expect(failure?.lastError).toContain('Could not resolve webhook hostname.');
        });
    });
});

