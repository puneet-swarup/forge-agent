// tests/google-adapter.test.js -- GoogleAdapter unit tests
'use strict';

const GoogleAdapter = require('../src/adapters/google-adapter');
const { getAdapter, getModelUrl, getModelDisplayName, SUPPORTED_MODELS } = require('../src/adapter-factory');

// A minimal Playwright-like Page mock.
function makePage() {
 const locator = {
 count: jest.fn().mockResolvedValue(0),
 isVisible: jest.fn().mockResolvedValue(false),
 isEnabled: jest.fn().mockResolvedValue(false),
 innerText: jest.fn().mockResolvedValue(''),
 click: jest.fn().mockResolvedValue(null),
 fill: jest.fn().mockResolvedValue(null),
 };
 return {
 locator: jest.fn(() => locator),
 $$: jest.fn().mockResolvedValue([]),
 $: jest.fn().mockResolvedValue(null),
 waitForTimeout: jest.fn().mockResolvedValue(null),
 waitForSelector: jest.fn().mockResolvedValue(null),
 goto: jest.fn().mockResolvedValue(null),
 evaluate: jest.fn().mockResolvedValue(null),
 keyboard: { press: jest.fn().mockResolvedValue(null), type: jest.fn().mockResolvedValue(null) },
 };
}

describe('GoogleAdapter', () => {
 let page;
 let adapter;
 const config = { RESPONSE_TIMEOUT: 5000, STABLE_DELAY: 10, GENERATION_POLL: 10 };

 beforeEach(() => {
 page = makePage();
 adapter = new GoogleAdapter(page, config);
 });

 test('extends BaseAdapter and exposes the full interface', () => {
 expect(typeof adapter.sendMessage).toBe('function');
 expect(typeof adapter.waitForResponse).toBe('function');
 expect(typeof adapter.discoverComposer).toBe('function');
 expect(typeof adapter.discoverSendButton).toBe('function');
 expect(typeof adapter.discoverLatestResponse).toBe('function');
 expect(typeof adapter.newChat).toBe('function');
 });

 test('returns non-trivial selector lists', () => {
 expect(adapter._getInputSelectors().length).toBeGreaterThanOrEqual(5);
 expect(adapter._getSendSelectors().length).toBeGreaterThanOrEqual(3);
 expect(adapter._getStopSelectors().length).toBeGreaterThanOrEqual(3);
 expect(adapter._getNewChatSelectors().length).toBeGreaterThanOrEqual(3);
 expect(adapter._getResponseSelectors().length).toBeGreaterThanOrEqual(3);
 });

 test('defaults to the Google AI Mode URL', () => {
 expect(adapter.getModelUrl()).toBe('https://www.google.com/ai');
 });

 test('honours a GOOGLE_URL override', () => {
 const custom = new GoogleAdapter(page, { ...config, GOOGLE_URL: 'https://www.google.com/search?udm=50' });
 expect(custom.getModelUrl()).toBe('https://www.google.com/search?udm=50');
 });

 test('does not navigate to /search?q= in sendMessage', async () => {
 // Discovery returns null -> sendMessage should throw, never call goto().
 await expect(adapter.sendMessage('hello')).rejects.toThrow(/Failed to send message/);
 expect(page.goto).not.toHaveBeenCalled();
 });

 test('discoverComposer returns null when no selector matches', async () => {
 await expect(adapter.discoverComposer()).resolves.toBeNull();
 });

 test('discoverSendButton returns null when no selector matches', async () => {
 await expect(adapter.discoverSendButton()).resolves.toBeNull();
 });

 test('discoverLatestResponse returns null when nothing visible', async () => {
 await expect(adapter.discoverLatestResponse()).resolves.toBeNull();
 });

 test('newChat navigates to the model URL', async () => {
 await expect(adapter.newChat()).resolves.toBe(true);
 expect(page.goto).toHaveBeenCalledWith(
 'https://www.google.com/ai',
 expect.objectContaining({ waitUntil: 'domcontentloaded' })
 );
 expect(adapter._isFirstMessage).toBe(true);
 });

 test('_cleanText still strips reasoning and prefixes (inherited)', () => {
 expect(adapter._cleanText('answer')).toBe('answer');
 expect(adapter._cleanText('base64:' + Buffer.from('plain').toString('base64'))).toBe('plain');
 });
});

describe('Google in AdapterFactory', () => {
 test('getAdapter returns a GoogleAdapter instance', () => {
 const page = makePage();
 expect(getAdapter('google', page, {})).toBeInstanceOf(GoogleAdapter);
 });

 test('aliases resolve to google', () => {
 const page = makePage();
 expect(getAdapter('search', page, {})).toBeInstanceOf(GoogleAdapter);
 expect(getAdapter('goog', page, {})).toBeInstanceOf(GoogleAdapter);
 });

 test('getModelUrl and display name are correct', () => {
 expect(getModelUrl('google')).toBe('https://www.google.com');
 expect(getModelDisplayName('google')).toBe('Google');
 });

 test('google is a supported model', () => {
 expect(SUPPORTED_MODELS).toContain('google');
 });
});
